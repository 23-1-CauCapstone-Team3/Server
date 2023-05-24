const mysql = require("../mysql/mysql");
const geohash = require("ngeohash");
const haversine = require("haversine");

const level = 6; // geohash level

// 10분 = 대각선 약 700m, 가로 세로는 500m
const walkunit = 50;

findTaxiPath = async (req, res) => {
  try {
    let {
      SX: startLng,
      SY: startLat,
      EX: endLng,
      EY: endLat,
      maxTransfer = 4,
      maxCost = 30000,
      maxWalking = 40,
    } = req.query;

    result = await raptorAlg({
      startLat,
      startLng,
      endLat,
      endLng,
      startDate: new Date("2023-05-19T20:24:00"),
      maxTransfer,
      // maxCost,
      // maxWalking,
    });

    res.send(result);
  } catch (err) {
    console.log(err);
    return res.status(400).send({ err: err.message });
  }
};

getWeeksFromDate = (now) => {
  const weeks = now.getDay();
  if (now.getHours() < 5) {
    weeks -= 1;

    if (weeks < 0) {
      weeks = 6;
    }
  }

  return weeks;
};

getTimeFromDate = (now) => {
  const time = now.getHours() * 60 + now.getMinutes();
  if (time < 420) {
    time += 1440;
  }

  return time;
};

// 길찾기 raptor 알고리즘의 변형
raptorAlg = async ({
  startLat,
  startLng,
  endLat,
  endLng,
  startDate = new Date(),
  maxTransfer,
  // maxCost,
  // maxWalking,
}) => {
  // 1. 초기화
  // ** 길찾기에 필요한 input data
  // 오늘 데이터
  const weeks = getWeeksFromDate(startDate);
  let busWeeks;
  if (weeks >= 0 && weeks <= 4) {
    busWeeks = "day";
  } else if (weeks === 5) {
    busWeeks = "sat";
  } else {
    busWeeks = "holiday";
  }

  const startTime = getTimeFromDate(startDate);

  const [
    { stationsByGeohash, stationInfos },
    { routesByStation, tripsByRoute, termByRoute },
  ] = await Promise.all([
    getEnableStationsFromDB(),
    getEnableRoutesFromDB({ busWeeks }),
  ]);

  // ** 길찾기 도중에 또는 output으로 사용될 data
  const reachedInfos = []; // 각 round별 도착시간, 소요도보시간, 소요택시비 저장
  const fastestReachedIndsByStation = {}; // 가장 빠른 도착시간 저장

  // ** 한 round에서 살펴볼 역들, 그 역에서 탑승할 수 있는 노선들 저장
  let markedRoutes = {};
  let { markedStations, initReachedInfo } = getInitInfos({
    startGeohash: geohash.encode(startLat, startLng),
    startTime,
    stationsByGeohash,
  }); // 초기화 필요
  reachedInfos.push(initReachedInfo);
  reachedInfos.push({});

  // 2. round 반복
  let k;
  for (k = 1; k <= maxTransfer; k++) {
    // maxTransfer 만큼의 round 반복
    markedRoutes = {};

    // 2-a. 같은 노선에 대해 더 이른 역에서 탑승할 수 있는 경우, 그 역에서 타면 됨
    // TODO: 급행 고려 필요 <- 급행 시간 잘 파악해보고, 늦은 시간에도 급행 다닌다면 고려해야 함
    for (const station of markedStations) {
      if (checkIsBus(station)) {
        // 버스 노선
        for (const route of routesByStation[station]) {
          let trip = getNowTrip({
            route,
            trip: tripsByRoute[route],
            station,
            term: termByRoute[route],
          });

          // trip 없는 노선은 배제시킴
          if (trip === null) continue;

          let nowStationInd = trip.findIndex(
            (ele) => ele.stationId === station
          );
          // 버스 시간표에 없는 노선은 배제시킴 (현재 일부 데이터만 있어서 필요한 line)
          if (nowStationInd === -1) continue;

          // 시간표에 노선 있는 경우, 더 앞에서 탈 수 있다면 기록
          if (route in markedRoutes) {
            // 같은 차를 여러 역에서 탈 수 있는 경우, 이른 역부터 살펴보기
            let origStationInd = markedRoutes[route].startStationInd;
            if (
              origStationInd ==
                trip.findIndex(
                  (ele) => ele.stationId === markedRoutes[route].startStationId
                ) &&
              nowStationInd < origStationInd
            ) {
              // 이번 역이 더 이른 역, 교체
              markedRoutes[route].startStationId = station;
              markedRoutes[route].startStationInd = nowStationInd;
            }
          } else {
            markedRoutes[route] = {
              startStationId: station,
              startStationInd: nowStationInd,
            };
          }
        }
      } else {
        // 지하철 노선
      }

      markedStations.delete(station);
    }

    // 2-b. 모든 가능 경로에 대해 이동
    for (const route in markedRoutes) {
      let startStation = markedRoutes[route].startStationId;

      arrTime = reachedInfos[k - 1][markedRoutes[route].startStationId].arrTime;
      let trip = getNowTrip({
        route,
        trip: tripsByRoute[route],
        station: startStation,
        term: termByRoute[route],
        arrTime,
      });

      const startStationInd = trip.findIndex(
        (info) => info.stationId == startStation
      );
      const size = trip.length;

      for (let i = startStationInd; i < size; i++) {
        // 기록된 시간보다 더 빠르게 도달한 경우
        let minArrTime = Number.MAX_SAFE_INTEGER;

        if (
          trip[i].stationId in fastestReachedIndsByStation &&
          minArrTime <
            reachedInfos[fastestReachedIndsByStation[trip[i].stationId]][
              trip[i].stationId
            ].arrTime
        ) {
          minArrTime =
            reachedInfos[fastestReachedIndsByStation[trip[i].stationId]][
              trip[i].stationId
            ].arrTime;
        }

        if (
          k != fastestReachedIndsByStation[trip[i].stationId] &&
          trip[i].stationId in reachedInfos[k] &&
          minArrTime < reachedInfos[k][trip[i].stationId].arrTime
        ) {
          minArrTime = reachedInfos[k][trip[i].stationId].arrTime;
        }

        if (trip[i].arrTime < minArrTime) {
          reachedInfos[k][trip[i].stationId] = {
            arrTime: trip[i].arrTime,
            walkingTime: reachedInfos[k - 1][startStation].walkingTime,
            privStationId: startStation,
            privRouteId: route,
          };
          fastestReachedIndsByStation[trip[i].stationId] = k;

          markedStations.add(trip[i].stationId);
        }

        // 더 빠른 시간에 열차 탑승이 가능한 경우, 이전 trip을 사용해도 됨
        if (k > 0 && reachedInfos[k - 1].arrTime <= trip[i].arrTime) {
          trip = getNowTrip({
            route,
            trip: tripsByRoute[route],
            station: trip[i].stationId,
            term: termByRoute[route],
            arrTime: reachedInfos[k - 1].arrTime,
          });
        }
      }
    }

    // 도보 이동
    // 그냥 한/인접한 geohash에서 남은 도보 시간만큼 인접 geohash까지 이동 가능
    let footReachedInfo;
    ({ markedStations, footReachedInfo } = getNextInfos({
      markedStations,
      reachedInfo: reachedInfos[k],
      stationsByGeohash,
      stationInfos,
    }));
    reachedInfos[k] = footReachedInfo;

    // 표시된 역 없는 경우 종료
    if (markedStations.size === 0 || k === maxTransfer) {
      break;
    } else {
      reachedInfos.push({});
    }
  }

  // TODO: 다 끝난 상황에서 어떻게 소요시간 및 길찾기 정보 제공할지
  return { reachedInfos, k };
};

getEnableStationsFromDB = async () => {
  let conn = null;

  let stationsByGeohash = {};
  let stationInfos = {};

  try {
    conn = await mysql.getConnection();

    const sql_train = `
      SELECT stat_id, geohash
      FROM train_station
      `;
    const sql_bus = `
      SELECT stat_id, geohash
      FROM bus_station
      `;

    const [train, bus] = await Promise.all([
      conn.query(sql_train),
      conn.query(sql_bus),
    ]);

    conn.release();

    // geohash별로 station id 묶기
    // for (station of train[0]) {
    //   if (!(station.geohash in stationsByGeohash)) {
    //     stationsByGeohash[station.geohash] = new Set();
    //   }
    //   stationsByGeohash[station.geohash].add(station.stat_id);

    //   stationsInfos[station.stat_id] = station;
    // }
    for (station of bus[0]) {
      if (!(station.geohash in stationsByGeohash)) {
        stationsByGeohash[station.geohash] = new Set();
      }

      stationsByGeohash[station.geohash].add(station.stat_id);

      stationInfos[station.stat_id] = station;
    }
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return { stationsByGeohash, stationInfos };
};

getEnableRoutesFromDB = async ({ busWeeks }) => {
  let conn = null;
  let result = {};

  try {
    conn = await mysql.getConnection();

    const sql_bus_trip = `
      SELECT *
      FROM bus_timetable
    `;
    const sql_bus_term = `
      SELECT route_id, ${busWeeks} as term
      FROM bus_route
    `;

    const [bus_trip, bus_term] = await Promise.all([
      conn.query(sql_bus_trip),
      conn.query(sql_bus_term),
    ]);

    conn.release();

    const routesByStation = {},
      tripsByRoute = {},
      termByRoute = {};

    for (info of bus_trip[0]) {
      if (!(info.stat_id in routesByStation)) {
        routesByStation[info.stat_id] = new Set();
      }
      routesByStation[info.stat_id].add(info.route_id);

      if (!(info.route_id in tripsByRoute)) {
        tripsByRoute[info.route_id] = [];
      }
      tripsByRoute[info.route_id].push({
        order: info.order,
        stationId: info.stat_id,
        arrTime: info.time,
      });
    }

    for (info of bus_term[0]) {
      termByRoute[info.route_id] = info.term;
    }

    result = {
      routesByStation,
      tripsByRoute,
      termByRoute,
    };
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return result;
};

checkIsBus = (id) => {
  if (id >= 100000000) return true;

  return false;
};

getNowTrip = ({ route, trip, station, term = 15, arrTime = -1 }) => {
  // TODO: 배차간격 없는 경우 일단 15분으로 처리해둠
  if (checkIsBus(station)) {
    // 배차간격 -1일 경우, 해당 요일에 운영 X
    if (term === -1) return null;

    // 1. 막차 시간 - (정류장 도달 시간)
    const startStationInd = trip.findIndex((el) => el.stationId === station);

    let diff;
    if (arrTime === -1) {
      diff = 0;
    } else {
      diff = trip[startStationInd].arrTime - (term + arrTime);
    }

    let newTrip = trip.map((el) => {
      return {
        arrTime: el.arrTime - diff,
        stationId: el.stationId,
        order: el.order,
      };
    });

    // 지나는 순서로 정렬
    newTrip = newTrip.sort((el1, el2) => el1.order - el2.order);

    return newTrip;
  }
};

getInitInfos = ({ startGeohash, startTime, stationsByGeohash }) => {
  const circleGeohash = getCircleGeohash({
    centerGeohash: startGeohash,
    radius: 500,
  });

  let markedStations = new Set();
  const initReachedInfo = {};

  for (hash in circleGeohash) {
    if (stationsByGeohash[hash] === undefined) {
      continue;
    }

    markedStations = new Set([...markedStations, ...stationsByGeohash[hash]]);

    for (station of stationsByGeohash[hash]) {
      const arrTime = startTime + circleGeohash[hash];

      initReachedInfo[station] = {
        arrTime,
        walkingTime: circleGeohash[hash],
        privStationId: null,
        privRouteId: null,
      };
    }
  }

  return { markedStations, initReachedInfo };
};

// 도보 이동 가능 역들 이동시키기
getNextInfos = ({
  markedStations,
  reachedInfo,
  stationsByGeohash,
  stationInfos,
}) => {
  // 전체 geohash 모으기
  const markedGeohashes = {};
  for (station in markedStations) {
    const hash = geohash.encode(
      stationInfos[station].lat,
      stationInfos[station].lng,
      level
    );

    if (
      !(hash in markedGeohashes) ||
      reachedInfo[station].arrTime < markedGeohashes[hash].arrTime
    ) {
      markedGeohashes[hash] = {
        arrTime: reachedInfo[station].arrTime,
        stationId: station,
        walkingTime: reachedInfo[station].walkingTime,
      };
    }
  }

  // 각 geohash에서 getCircleGeohash 호출
  for (hash in markedGeohashes) {
    geohashes = getCircleGeohash({ centerGeohash: hash, radius: 500 });

    // hash 안에 있는 역들마다, 새 key 저장
    for (curHash in geohashes) {
      curHashInfo = markedGeohashes[curHash];

      for (station in stationsByGeohash[curHash]) {
        if (
          station === curHashInfo.stationId &&
          reachedInfo[station].arrTime > markedGeohashes[curHash].arrTime + 10
        ) {
          // 갱신
          reachedInfo[station] = {
            ...reachedInfo[station],
            arrTime: markedGeohashes[curHash].arrTime,
          };
        } else if (
          station !== curHashInfo.stationId &&
          reachedInfo[station].arrTime >
            markedGeohashes[curHash].arrTime + geohashes[curHash] + 5
        ) {
          // 갱신
          reachedInfo[station] = {
            ...reachedInfo[station],
            arrTime: markedGeohashes[curHash].arrTime + geohashes[curHash] + 5,
            walkingTime:
              markedGeohashes[curHash].walkingTime + geohashes[curHash] + 5,
            privStationId: markedGeohashes[curHash].stationId,
            privRouteId: null,
          };
        }
      }
    }
  }

  // mark
  markedStations = new Set([...Object.keys(reachedInfo), ...markedStations]);

  return {
    markedStations,
    footReachedInfo: reachedInfo,
  };
};

// centerGeohash를 중심으로 radius를 반지름으로 하는 원을 geohash들로 만들어 리턴
getCircleGeohash = ({ centerGeohash, radius }) => {
  const centerPoint = geohash.decode(centerGeohash);

  const geohashes = {};
  // ** geohashes
  // { geohash: walkingTime }

  exploreCircle = (hash) => {
    const neighborPoint = geohash.decode(hash);
    const distance = haversine(
      {
        latitude: centerPoint.latitude,
        longitude: centerPoint.longitude,
      },
      {
        latitude: neighborPoint.latitude,
        longitude: neighborPoint.longitude,
      },
      { unit: "meter" }
    );

    if (distance > radius) return;

    const neighbors = findNeighbors(hash);

    for (let i = 0; i < 4; i++) {
      if (!(neighbors[i] in geohashes)) {
        geohashes[neighbors[i]] = Math.round(radius / walkunit);
        exploreCircle(neighbors[i]);
      }
    }
  };

  exploreCircle(centerGeohash);

  return geohashes;
};

findNeighbors = (hash) => {
  const neighbors = [];

  // 주어진 Geohash를 위경도로 디코드
  const { latitude, longitude } = geohash.decode(hash, level);

  // 이웃하는 Geohash의 방향과 거리
  const directions = [
    [1, 0], // 동쪽 (East)
    [-1, 0], // 서쪽 (West)
    [0, 1], // 남쪽 (South)
    [0, -1], // 북쪽 (North)
  ];
  const distance = 1;

  // 각 방향별로 이웃 Geohash 생성
  for (const [dx, dy] of directions) {
    const newLatitude = latitude + dx * distance * 0.005;
    const newLongitude = longitude + dy * distance * 0.005;

    const neighborGeohash = geohash.encode(newLatitude, newLongitude, level);
    neighbors.push(neighborGeohash);
  }

  return neighbors;
};

module.exports = {
  findTaxiPath,
};
