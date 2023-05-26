const mysql = require("../mysql/mysql");
const geohash = require("ngeohash");
const haversine = require("haversine");

const level = 6; // geohash level

// 10분 = 대각선 약 700m, 가로 세로는 500m
// 1분에 약 50m 이동 가능하다고 가정
const walkunit = 50;

// 기본 상수
const defaultMaxTransfer = 4;
const defaultMaxCost = 30000;
const defaultMaxWalking = 40;

const findTaxiPath = async (req, res) => {
  try {
    let {
      SX: startLng,
      SY: startLat,
      EX: endLng,
      EY: endLat,
      startTime,
      maxTransfer = defaultMaxTransfer,
      maxCost = defaultMaxCost,
      maxWalking = defaultMaxWalking,
    } = req.query;

    result = await raptorAlg({
      startLat,
      startLng,
      endLat,
      endLng,
      startDate: new Date("2023-05-25T22:00:00"),
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

// TODO: 성엽님이 만든 함수로 대체하기
const checkIsHoliday = (date) => {
  let isHoliday = false;

  const solarHoliday = new Set([
    "0101",
    "0301",
    "0505",
    "0606",
    "0815",
    "1003",
    "1009",
    "1225",
  ]);
  const lunarHoliday = new Set(["0527", "0928", "0929", "0930"]);

  if (
    getDateStringToDate(date) in solarHoliday ||
    getDateStringToDate(date) in lunarHoliday
  ) {
    isHoliday = true;
  }

  return isHoliday;
};

const getDateStringToDate = (date) => {
  return (
    (date.getMonth() + 1 < 9
      ? "0" + (date.getMonth() + 1)
      : date.getMonth() + 1) +
    (date.getDate() < 9 ? "0" + date.getDate() : date.getDate())
  );
};

const getWeekFromDate = (date) => {
  const week = date.getDay();
  if (date.getHours() < 5) {
    week -= 1;

    if (week < 0) {
      week = 6;
    }
  }

  return week;
};

const getTrainWeekFromWeek = (date) => {
  if (checkIsHoliday(date)) return 3;

  const week = getWeekFromDate(date);

  let trainWeek;
  if (week >= 0 && week <= 4) {
    trainWeek = 1;
  } else if (week === 5) {
    trainWeek = 2;
  } else {
    trainWeek = 3;
  }

  return trainWeek;
};

const getBusWeekFromWeek = (date) => {
  if (checkIsHoliday(date)) return "holiday";

  const week = getWeekFromDate(date);

  let busWeek;
  if (week >= 0 && week <= 4) {
    busWeek = "day";
    trainWeek = "";
  } else if (week === 5) {
    busWeek = "sat";
  } else {
    busWeek = "holiday";
  }

  return busWeek;
};

const getTimeFromDate = (now) => {
  const time = now.getHours() * 60 + now.getMinutes();
  if (time < 7 * 60) {
    time += 24 * 60;
  }

  return time;
};

const getTrainRouteId = ({ routeName, inout }) => {
  return routeName + "-" + String(inout);
};

// 길찾기 raptor 알고리즘의 변형
const raptorAlg = async ({
  startLat,
  startLng,
  endLat,
  endLng,
  startDate = new Date(),
  maxTransfer,
  // maxCost,
  // maxWalking,
}) => {
  // startDate 보정
  if (getTimeFromDate(startDate) < 7 * 60) {
    startDate.setDate(startDate.getDate() + 1);
  }

  // 1. 초기화
  // ** 길찾기에 필요한 input data
  // 오늘 데이터
  const busWeek = getBusWeekFromWeek(startDate),
    trainWeek = getTrainWeekFromWeek(startDate);

  const startTime = getTimeFromDate(startDate);

  const [
    { stationsByGeohash, stationInfos },
    { routesByStation, tripsByRoute, termByRoute },
  ] = await Promise.all([
    getEnableStationsFromDB(),
    getEnableRoutesFromDB({ busWeek, trainWeek }),
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
      for (const route of routesByStation[station]) {
        let trip = getNowTrip({
          route,
          trip: tripsByRoute[route],
          station,
          term: termByRoute[route],
          arrTime: reachedInfos[k - 1][station].arrTime,
        });

        // trip 없는 노선은 배제시킴
        if (trip === null) continue;

        let nowStationInd = trip.findIndex((ele) => ele.stationId === station);
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

const getEnableStationsFromDB = async () => {
  let conn = null;

  const stationsByGeohash = {},
    stationInfos = {};

  try {
    conn = await mysql.getConnection();

    const sql_train = `
      SELECT *
      FROM train_station
      `;
    const sql_bus = `
      SELECT *
      FROM bus_station
      `;

    const [train, bus] = await Promise.all([
      conn.query(sql_train),
      conn.query(sql_bus),
    ]);

    conn.release();
    // geohash별로 station id 묶기
    for (const station of train[0]) {
      if (!(station.geohash in stationsByGeohash)) {
        stationsByGeohash[station.geohash] = new Set();
      }
      stationsByGeohash[station.geohash].add(station.stat_id);

      stationInfos[station.stat_id] = {
        stationName: station.stat_name,
        lat: station.lat,
        lng: station.lng,
      };
    }

    for (const station of bus[0]) {
      if (!(station.geohash in stationsByGeohash)) {
        stationsByGeohash[station.geohash] = new Set();
      }
      stationsByGeohash[station.geohash].add(station.stat_id);

      stationInfos[station.stat_id] = {
        stationName: station.stat_name,
        lat: station.lat,
        lng: station.lng,
      };
    }
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return { stationsByGeohash, stationInfos };
};

const getEnableRoutesFromDB = async ({ busWeek, trainWeek }) => {
  let conn = null;
  let result = {};

  try {
    conn = await mysql.getConnection();

    const sql_train_trip = `
      SELECT *
      FROM train_timetable
      WHERE week ${trainWeek == 1 ? " = 1" : " >= 2"}
    `;
    const sql_bus_trip = `
      SELECT *
      FROM bus_timetable
    `;
    const sql_bus_term = `
      SELECT route_id, ${busWeek} as term
      FROM bus_route
    `;

    const [train_trip, bus_trip, bus_term] = await Promise.all([
      conn.query(sql_train_trip),
      conn.query(sql_bus_trip),
      conn.query(sql_bus_term),
    ]);

    conn.release();

    const routeIncludesWeek3 = new Set([
      "1호선",
      "2호선",
      "3호선",
      "4호선",
      "5호선",
      "6호선",
      "7호선",
      "8호선",
      "9호선",
    ]);

    const routesByStation = {},
      tripsByTrainRoute = {},
      tripsByBusRoute = {},
      termByRoute = {};

    for (const info of train_trip[0]) {
      if (info.route_name in routeIncludesWeek3 && info.week != trainWeek) {
        // 필요없는 정보
        continue;
      }

      const id = getTrainRouteId({
        routeName: info.route_name,
        inout: info.inout,
      });

      if (!(info.stat_id in routesByStation)) {
        routesByStation[info.stat_id] = new Set();
      }
      routesByStation[info.stat_id].add(id);

      if (!(id in tripsByTrainRoute)) {
        tripsByTrainRoute[id] = {};
      }
      if (!(info.train_id in tripsByTrainRoute[id])) {
        tripsByTrainRoute[id][info.train_id] = [];
      }

      tripsByTrainRoute[id][info.train_id].push({
        order: info.order,
        stationId: info.stat_id,
        arrTime: info.time,
      });
    }
    for (const id in tripsByTrainRoute) {
      for (const trainId in tripsByTrainRoute[id]) {
        tripsByTrainRoute[id][trainId] = tripsByTrainRoute[id][trainId].sort(
          (el1, el2) => el1.order - el2.order
        );
      }
    }

    for (const info of bus_trip[0]) {
      if (!(info.stat_id in routesByStation)) {
        routesByStation[info.stat_id] = new Set();
      }
      routesByStation[info.stat_id].add(info.route_id);

      if (!(info.route_id in tripsByBusRoute)) {
        tripsByBusRoute[info.route_id] = [];
      }
      tripsByBusRoute[info.route_id].push({
        order: info.order,
        stationId: info.stat_id,
        arrTime: info.time,
      });
    }
    for (const route in tripsByBusRoute) {
      tripsByBusRoute[route] = tripsByBusRoute[route].sort(
        (el1, el2) => el1.order - el2.order
      );
    }

    for (const info of bus_term[0]) {
      termByRoute[info.route_id] = info.term;
    }

    const tripsByRoute = { ...tripsByTrainRoute, ...tripsByBusRoute };

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

const checkIsBus = (id) => {
  if (parseInt(id) >= 100000000) return true;

  return false;
};

const getNowTrip = ({ route, trip, station, term = 15, arrTime = -1 }) => {
  // TODO: 배차간격 없는 경우 일단 15분으로 처리해둠 -> radius walkUnit 등 모든 상수 리팩토링 필요
  if (checkIsBus(station)) {
    // 버스
    // 배차간격 -1일 경우, 해당 요일에 운영 X
    if (term === -1) return null;

    // 1. 막차 시간 - (정류장 도달 시간) 차 계산
    const startStationInd = trip.findIndex((el) => el.stationId === station);

    // 정류장을 지나지 않는 경우 (오류 case)
    if (startStationInd === -1) return null;

    let diff;
    if (arrTime === -1) {
      diff = 0;
    } else {
      diff = trip[startStationInd].arrTime - (term + arrTime);
    }

    // 2. 정류장에 도착한 뒤, 배차 간격만큼 대기 후 오는 차를 타도록 함
    let newTrip = trip.map((el) => {
      return {
        arrTime: el.arrTime - diff,
        stationId: el.stationId,
        order: el.order,
      };
    });

    return newTrip;
  } else {
    // 지하철
    // 1. 가장 가까운 정보 찾기
    let selectedTrainId = -1,
      minArrTime = Number.MAX_SAFE_INTEGER;

    for (const trainId in trip) {
      const startStationInd = trip[trainId].findIndex(
        (el) => el.stationId === station
      );

      if (startStationInd === -1) continue;

      if (minArrTime > trip[trainId][startStationInd].arrTime) {
        selectedTrainId = trainId;
        minArrTime = trip[trainId][startStationInd].arrTime;
      }
    }

    if (selectedTrainId === -1) return null;

    let newTrip = trip[selectedTrainId];
    // TODO: 지하철 방향별 차 고려하도록 수정해야 함 -> 급행 또는 방향이 갈리는 몇몇 노선들에 대해

    return newTrip;
  }
};

const getInitInfos = ({ startGeohash, startTime, stationsByGeohash }) => {
  const circleGeohash = getCircleGeohash({
    centerGeohash: startGeohash,
    radius: 500 * 2,
  });

  let markedStations = new Set();
  const initReachedInfo = {};

  for (const hash in circleGeohash) {
    if (stationsByGeohash[hash] === undefined) {
      continue;
    }

    markedStations = new Set([...markedStations, ...stationsByGeohash[hash]]);

    for (const station of stationsByGeohash[hash]) {
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
const getNextInfos = ({
  markedStations,
  reachedInfo,
  stationsByGeohash,
  stationInfos,
}) => {
  // 전체 geohash 모으기
  const markedGeohashes = {};
  for (const station in markedStations) {
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
  for (const hash in markedGeohashes) {
    const geohashes = getCircleGeohash({
      centerGeohash: hash,
      radius: 500 * 2,
    });

    // hash 안에 있는 역들마다, 새 key 저장
    for (const curHash in geohashes) {
      curHashInfo = markedGeohashes[curHash];

      for (const station in stationsByGeohash[curHash]) {
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
            markedGeohashes[curHash].arrTime + geohashes[curHash]
        ) {
          // 갱신
          reachedInfo[station] = {
            ...reachedInfo[station],
            arrTime: markedGeohashes[curHash].arrTime + geohashes[curHash],
            walkingTime:
              markedGeohashes[curHash].walkingTime + geohashes[curHash],
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
const getCircleGeohash = ({ centerGeohash, radius }) => {
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

const findNeighbors = (hash) => {
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
