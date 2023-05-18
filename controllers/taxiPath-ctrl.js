const mysql = require("../mysql/mysql");

findTaxiPath = async (req, res) => {
  try {
    let {
      SX: startLng,
      SY: startLat,
      EX: endLng,
      EY: endLat,
      maxTransfer = 5,
      maxCost = 30000,
      maxWalking = 40,
    } = req.query;

    const { startTime } = getNowTime();

    result = await raptorAlg({
      // startLat,
      // startLng,
      // endLat,
      // endLng,
      startTime,
      // weeks
      // maxTransfer,
      // maxCost,
      // maxWalking,
    });

    res.send({
      result,
    });
  } catch (err) {
    return res.status(400).send({ err: err.message });
  }
};

getTodayInfos = () => {
  // const now = new Date(2023, 4, 19, 21, 30, 0, 0); // 5/19 9:30PM
  const now = new Date();

  const startTime = now.getHours() * 100 + now.getMinutes();
  const weeks = now.getDay();
  if (startTime < 500) {
    startTime += 2400;
    weeks -= 1;
    if (weeks < 0) {
      weeks = 6;
    }
  }

  return { startTime, weeks };
};

// 길찾기 raptor 알고리즘의 변형
raptorAlg = async ({
  // startLat,
  // startLng,
  // endLat,
  // endLng,
  startTime,
  // maxTransfer,
  // maxCost,
  // maxWalking,
}) => {
  // 1. 초기화
  // ** 길찾기에 필요한 input data
  // stationsByGeohash
  // {
  //   geoHash: Set(stationId1, 2, ... )
  // }
  // routesByStation
  // {
  //   stationId: Set(routeId1, 2, ...)
  // }
  // tripsByRoute
  // {
  //   busRouteId: [
  //     {
  //       stationId,
  //       arrTime
  //     }
  //   ],
  //   trainRouteId: [
  //     [
  //       {
  //         stationId,
  //         arrTime
  //       }
  //     ]
  //   ]
  // }
  const [stationsByGeohash, { routesByStation, tripsByRoute }] =
    await Promise.all([getEnableStationsFromDB(), getEnableRoutesFromDB()]);

  // ** 길찾기 도중에 또는 output으로 사용될 data
  // reachedInfos
  // [ {
  //   staionId: {
  //     arrTime,
  //     walkingTime,
  //     taxiCost,
  //     privStationId,
  //     privRouteId
  //   }
  // } ]
  // fastestReachedInfos
  // [ {
  //   staionId: indexOfReachedInfosArray
  // } ]
  const reachedInfos = new Array(5); // 각 round별 도착시간, 소요도보시간, 소요택시비 저장
  for (let i = 0; i < maxTransfer; i++) {
    reachedInfos[i] = {};
  }
  const fastestReachedInds = {}; // 가장 빠른 도착시간 저장

  // ** 한 round에서 살펴볼 역들, 그 역에서 탑승할 수 있는 노선들 저장
  // markedRoutes
  // {
  //   routeId: {
  //     startStationId,
  //     startStationInd,
  //     arrTime
  //   }
  // }
  const markedRoutes = {};
  const { markedStations, initReachedInfo } = getInitInfos(
    startLat,
    startLng,
    startTime,
    stationsByGeohash
  ); // 초기화 필요
  reachedInfos[0] = initReachedInfo;

  // 2. round 반복
  for (let k = 0; k < maxTransfer; k++) {
    // maxTransfer 만큼의 round 반복
    markedRoutes = {};

    // 2-a. 같은 노선에 대해 더 이른 역에서 탑승할 수 있는 경우, 그 역에서 타면 됨
    // TODO: 급행 고려 필요 <- 급행 시간 잘 파악해보고, 늦은 시간에도 급행 다닌다면 고려해야 함
    for (const station in markedStations) {
      for (const route in routesByStation[station]) {
        let trip = getNowTrip(route, tripsByRoute[route], station);
        let nowStationInd = trip.find((ele) => ele.stationId === station);
        if (route in markedRoutes) {
          // 같은 차를 여러 역에서 탈 수 있는 경우, 이른 역부터 살펴보기
          let origStationInd = markedRoutes[route].startStationInd;

          if (
            originStationInd ==
              trip.find(
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
    for (const route in markedRoutes.keys()) {
      let startStation = markedRoutes[route];
      let trip = getNowTrip(
        route,
        tripsByRoute[route],
        startStation,
        reachedInfos[k - 1][startStation].arrTime
      );

      let startStationInd =
        trip !== null
          ? trip.find((info) => info.stationId == startStation)
          : -1;
      let size = trip !== null ? trip.size : -1;

      for (let i = startStationInd; i < size; i++) {
        // 기록된 시간보다 더 빠르게 도달한 경우
        if (
          trip[i].arrTime <
          Math.min(
            ReachedInfos[fastestReachedInds[trip[i].stationId]].arrTime,
            ReachedInfos[fastestReachedInds[trip[i].stationId]].arrTime
          )
        ) {
          reachedInfos[k][trip[i].stationId] = {
            arrTime: trip[i].arrTime,
            walkingTime: reachedInfos[k - 1].walkingTime,
            privStationId: startStation,
            privRouteId: route,
          };
          fastestReachedInds[trip[i].stationId] = k;

          markedStations.add(trip[i].stationId);
        }

        // 더 빠른 시간에 열차 탑승이 가능한 경우, 이전 trip을 사용해도 됨
        if (reachedInfos[k - 1].arrTime <= trip[i].arrTime) {
          trip = getNowTrip(
            route,
            tripsByRoute[route],
            trip[i].stationId,
            reachedInfos[k - 1].arrTime
          );
        }
      }
    }

    // 도보 이동
    // 그냥 한/인접한 geohash에서 남은 도보 시간만큼 인접 geohash까지 이동 가능
    getNextInfos(markedStations, reachedInfos[k], stationsByGeohash);

    // 표시된 역 없는 경우 종료
    if (markedStations.size === 0) {
      break;
    }
  }

  // TODO: 다 끝난 상황에서 어떻게 소요시간 및 길찾기 정보 제공할지
};

getEnableStationsFromDB = async () => {
  let conn = null;
  let result = {};

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
    for (station of train[0]) {
      if (!(station.geohash in result)) {
        result[station.geohash] = new Set();
      }

      result[station.geohash].add(station.stat_id);
    }
    for (station of bus[0]) {
      if (!(station.geohash in result)) {
        result[station.geohash] = new Set();
      }

      result[station.geohash].add(station.stat_id);
    }
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return result;
};

getEnableRoutesFromDB = async () => {
  let conn = null;
  let result = {};

  try {
    conn = await mysql.getConnection();

    const sql_bus_trip = `
      SELECT stat_id, route_id, time
      FROM bus_timetable
    `;

    const bus_trip = await conn.query(sql_bus_trip);

    conn.release();

    const routesByStation = {};
    const tripsByRoute = {};
    for (trip of bus_trip[0]) {
      if (!(trip.stat_id in routesByStation)) {
        routesByStation[trip.stat_id] = new Set();
      }
      routesByStation[trip.stat_id].add(trip.route_id);

      if (!(trip.route_id in tripsByRoute)) {
        tripsByRoute[trip.route_id] = [];
      }
      tripsByRoute[trip.route_id].push({
        stationId: trip.stat_id,
        arrTime: trip.time,
      });
    }

    result = {
      routesByStation,
      tripsByRoute,
    };
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return result;
};

getNowTrip = (route, trip, station) => {};

getInitInfos = (startLat, startLng, startTime, stationsByGeohash) => {};

getNextInfos = (martkedStations, reachedInfos, stationsByGeohash) => {};

module.exports = {
  findTaxiPath,
};
