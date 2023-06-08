const mysql = require("../mysql/mysql");
const axios = require("axios");
const qs = require("qs");
const geohash = require("ngeohash");
const haversine = require("haversine");

const GEOHASH_LEVEL = 6; // geohash level

// 10분 = 대각선 약 700m, 가로 세로는 500m
// 1분에 약 50m 이동 가능하다고 가정
const DEFAULT_WALKING_UNIT = 50,
  // 1분에 약 400m 이동 가능하다고 가정
  DEFAULT_TAXI_UNIT = 400;

// *** 기본 상수
const DEFAULT_MAX_TRANSFER = 5;
const DEFAULT_MAX_COST = 35000;
const DEFAULT_MAX_WALKING = 45;
const DEFAULT_MAX_WALKING_PER_STEP = 30;
const WALKING_ROUTE_ID = "walking";
const TAXI_ROUTE_ID = "taxi";

const TRAIN_CODE = 1,
  BUS_CODE = 2,
  WALKING_CODE = 3,
  TRANSFER_WALKING_CODE = 4,
  TAXI_CODE = 5;

const findTaxiPath = async (req, res) => {
  try {
    let {
      startX: startLng,
      startY: startLat,
      endX: endLng,
      endY: endLat,
      time: startDate = new Date(),
      walkSpeed: walkingUnit = DEFAULT_WALKING_UNIT,
      taxiSpeed: taxiUnit = DEFAULT_TAXI_UNIT,
      maxTransfer = DEFAULT_MAX_TRANSFER,
      maxCost = DEFAULT_MAX_COST,
      maxTotalWalkTime: maxWalking = DEFAULT_MAX_WALKING,
      maxWalkTimePerStep: maxWalkingPerEachStep = DEFAULT_MAX_WALKING_PER_STEP,
    } = req.query;

    let isIncludeTaxi = false; // 길찾기에 택시가 포함되어야 하는지 여부를 저장하는 flag 변수
    startDate = new Date(startDate);

    // 1. 길찾기에 쓰이는 데이터 구축
    const {
      startTime,
      stationsByGeohash,
      stationInfos,
      additionalTrainCostByStatNames,
      routesByStation,
      tripsByRoute,
      busRouteInfos,
    } = await init({ startDate });

    // 2. raptor 알고리즘에 필요한 시작/끝역 초기 데이터 구축
    const { markedStations, initReachedInfo } = getInitInfos({
      // startGeohash: geohash.encode(startLat, startLng),
      startLat,
      startLng,
      startTime,
      stationInfos,
      stationsByGeohash,
      radius: maxWalkingPerEachStep * walkingUnit,
      walkingUnit,
    });
    const endMarkedStations = getFinalInfo({
      // endGeohash: geohash.encode(endLat, endLng),
      endLat,
      endLng,
      stationInfos,
      stationsByGeohash,
      radius: maxWalkingPerEachStep * walkingUnit,
      walkingUnit,
    });

    // 3. raptor 수행
    let { reachedInfos, transferNum } = raptorAlg({
      // *** 길찾기 데이터
      stationsByGeohash,
      stationInfos,
      routesByStation,
      tripsByRoute,
      busRouteInfos,
      // *** 시작 역 데이터
      markedStations,
      initReachedInfo,
      // *** alg setting
      maxTransfer,
      maxWalkingPerEachStep,
      walkingUnit,
    });

    // res.send({ transferNum, reachedInfos });
    // return;

    // 4. raptor 결과 -> 경로
    let paths = mkPaths({
      // *** 경로 만들 데이터
      startTime,
      reachedInfos,
      transferNum,
      endMarkedStations,
      startLng,
      startLat,
      endLng,
      endLat,
      // *** 경로 세부정보 추가를 위한 데이터
      stationInfos,
      tripsByRoute,
      busRouteInfos,
      additionalTrainCostByStatNames,
      // *** alg setting
      walkingUnit,
      taxiUnit,
    });

    // 5. paths들 추려내기
    paths = selectAndSortPaths({
      paths,
      // *** alg setting
      maxCost,
      maxWalking,
      isIncludeTaxi,
    });

    // 도보만으로는 이동 불가 case -> 끝부분 택시 이동
    if (paths.length === 0) {
      isIncludeTaxi = true;
      console.log("마지막역 -> 도착지 택시 필요");

      const endTaxiMarkedStations = getFinalInfo({
        // endGeohash: geohash.encode(endLat, endLng),
        endLat,
        endLng,
        stationInfos,
        stationsByGeohash,
        radius: getDistFromTaxiCost({
          cost: maxCost,
          arrTime: -1,
        }),
        walkingRadius: maxWalkingPerEachStep * walkingUnit,
        walkingUnit,
        taxiUnit,
        isWalking: false,
      });

      // 기존 길찾기 결과에서, 마지막 경로가 taxi 이동 허용하는 것 선택
      paths = mkPaths({
        // *** 경로 만들 데이터
        startTime,
        reachedInfos,
        transferNum,
        endMarkedStations: endTaxiMarkedStations,
        isLastWalking: false,
        startLng,
        startLat,
        endLng,
        endLat,
        // *** 경로 세부정보 추가를 위한 데이터
        stationInfos,
        additionalTrainCostByStatNames,
        tripsByRoute,
        busRouteInfos,
        // *** alg setting
        walkingUnit,
        taxiUnit,
      });

      // paths들 추려내기
      paths = selectAndSortPaths({
        paths,
        // *** alg setting
        maxCost,
        maxWalking,
        isIncludeTaxi,
      });
    }

    // 끝부분 택시 이동 불가 case -> 앞부분 택시 이동
    if (paths.length === 0) {
      console.log("출발지 -> 첫역 택시 필요");

      const {
        markedStations: taxiMarkedStations,
        initReachedInfo: taxiInitReachedInfo,
      } = getInitInfos({
        // startGeohash: geohash.encode(startLat, startLng),
        startLat,
        startLng,
        startTime,
        stationsByGeohash,
        stationInfos,
        radius: getDistFromTaxiCost({
          cost: maxCost,
          arrTime: getTimeFromDate(startDate),
        }),
        walkingRadius: maxWalkingPerEachStep * walkingUnit,
        walkingUnit,
        taxiUnit,
        isWalking: false,
      });

      ({ reachedInfos, transferNum } = raptorAlg({
        // *** 길찾기 데이터
        stationsByGeohash,
        stationInfos,
        routesByStation,
        tripsByRoute,
        busRouteInfos,
        // *** 시작 역 데이터
        markedStations: taxiMarkedStations,
        initReachedInfo: taxiInitReachedInfo,
        // *** alg setting
        maxTransfer,
        maxWalkingPerEachStep,
        walkingUnit,
      }));

      // 기존 길찾기 결과에서, 마지막 경로가 taxi 이동 허용하는 것 선택
      paths = mkPaths({
        // *** 경로 만들 데이터
        startTime,
        reachedInfos,
        transferNum,
        endMarkedStations,
        startLng,
        startLat,
        endLng,
        endLat,
        // *** 경로 세부정보 추가를 위한 데이터
        stationInfos,
        additionalTrainCostByStatNames,
        tripsByRoute,
        busRouteInfos,
        // *** alg setting
        walkingUnit,
        taxiUnit,
      });

      // paths들 추려내기
      paths = selectAndSortPaths({
        paths,
        // *** alg setting
        maxCost,
        maxWalking,
        isIncludeTaxi,
      });
    }

    if (paths.length === 0) {
      // 어떠한 경로도 없는 경우
      res.send({
        pathExistence: false,
      });
      return;
    }

    // 6. 추려낸 path에 대해 도보, 택시 정보 추가 및 값 보정
    paths = await addRealtimeInfos({
      startDate,
      paths: [paths[0]],
    });

    res.send({
      pathExistence: true,
      departureTime: paths[0].info.departureTime,
      arrivalTime: paths[0].info.arrivalTime,
      pathInfo: paths[0],
    });
  } catch (err) {
    console.log(err);
    return res.status(400).send({ err: err.message });
  }
};

// *** 길찾기 alg에 필요한 모든 input data 설정
const init = async ({ startDate }) => {
  // DB에서 정보 가져오기
  const [
    { stationsByGeohash, stationInfos, additionalTrainCostByStatNames },
    { routesByStation, tripsByRoute, busRouteInfos },
  ] = await Promise.all([
    getEnableStationsFromDB(),
    getEnableRoutesFromDB(startDate),
  ]);

  return {
    startTime: getTimeFromDate(startDate),
    stationsByGeohash,
    stationInfos,
    additionalTrainCostByStatNames,
    routesByStation,
    tripsByRoute,
    busRouteInfos,
  };
};

// *** 길찾기 raptor 알고리즘의 변형
const raptorAlg = ({
  // *** 길찾기 데이터
  stationsByGeohash,
  stationInfos,
  routesByStation,
  tripsByRoute,
  busRouteInfos,
  // *** 시작 역 데이터
  markedStations,
  initReachedInfo,
  // *** alg setting
  maxTransfer,
  maxWalkingPerEachStep,
  walkingUnit,
}) => {
  console.log("raptor 알고리즘 시작");

  // ** 길찾기 도중에 또는 output으로 사용될 data
  const reachedInfos = []; // 각 round별 도착시간, 소요도보시간, 소요택시비 저장
  const fastestReachedIndsByStation = {}; // 가장 빠른 도착시간 저장

  reachedInfos.push(initReachedInfo);
  reachedInfos.push({});

  // 2. round 반복
  let transportNum; // 대중교통 탑승 횟수
  for (transportNum = 1; transportNum <= maxTransfer + 1; transportNum++) {
    // maxTransfer 만큼의 round 반복
    let markedRoutes = {};

    // 2-a. 같은 노선에 대해 더 이른 역에서 탑승할 수 있는 경우, 그 역에서 타면 됨
    for (const station of markedStations) {
      // 해당 역에 노선 없으면 break
      // console.log(routesByStation[station], station);
      if (routesByStation[station] === undefined) {
        markedStations.delete(station);
        continue;
      }

      for (const route of routesByStation[station]) {
        let { trip, startStationInd } = getNowTrip({
          route,
          trip: tripsByRoute[route],
          station,
          term: route in busRouteInfos ? busRouteInfos[route].term : -1,
          arrTime: reachedInfos[transportNum - 1][station].arrTime,
        });

        // trip 없는 노선은 배제시킴
        if (trip === null) continue;

        // 시간표에 노선 있는 경우, 더 앞에서 탈 수 있다면 기록
        if (route in markedRoutes) {
          // 같은 차를 여러 역에서 탈 수 있는 경우, 이른 역부터 살펴보기
          let origStationInd = markedRoutes[route].startStationInd;

          if (
            origStationInd ==
              trip.findIndex(
                (ele) => ele.stationId == markedRoutes[route].startStationId
              ) &&
            startStationInd < origStationInd
          ) {
            // 이번 역이 더 이른 역, 교체
            markedRoutes[route].startStationId = station;
            markedRoutes[route].startStationInd = startStationInd;
          }
        } else {
          markedRoutes[route] = {
            startStationId: station,
            startStationInd: startStationInd,
          };
        }
      }

      markedStations.delete(station);
    }

    // 2-b. 모든 가능 경로에 대해 이동
    for (const route in markedRoutes) {
      let startStation = markedRoutes[route].startStationId;
      let startStationInd = markedRoutes[route].startStationInd;
      let startArrTime = reachedInfos[transportNum - 1][startStation].arrTime;

      let { trip } = getNowTrip({
        route,
        trip: tripsByRoute[route],
        station: startStation,
        term: route in busRouteInfos ? busRouteInfos[route].term : -1,
        arrTime: startArrTime,
      });

      const size = trip.length;
      let prevId = null,
        prevArrTime = 0;

      // if (!checkIsBusStation(startStation) && transportNum == 1)
      //   console.log(
      //     // trip,
      //     transportNum,
      //     stationInfos[startStation].stationName,
      //     route
      //   );

      // if (
      //   !checkIsBusStation(startStation) &&
      //   stationInfos[startStation].stationName === "상도"
      // )
      //   console.log(
      //     trip,
      //     transportNum,
      //     stationInfos[startStation].stationName,
      //     route,
      //     startStationInd,
      //     size
      //   );

      for (let i = startStationInd + 1; i < size; i++) {
        if (trip[i].stationId == prevId) continue; // 중복역 pass
        if (!(trip[i].stationId in stationInfos)) continue; // DB에 존재하지 않는 역정보 pass
        if (trip[i].arrTime < prevArrTime) break; // 회차지에서 차가 끊기는 case pass

        // if (
        //   !checkIsBusStation(trip[i].stationId) &&
        //   stationInfos[trip[i].stationId].stationName === "상도"
        // )
        //   console.log(
        //     // trip,
        //     transportNum,
        //     stationInfos[trip[i].stationId].stationName,
        //     route
        //   );

        let minArrTime = 100 * 60; // 초기 최소 시간은 아주 크게 설정

        // // (저번 for문 iteration들에서) 가장 빠르게 해당 역에 도달한 기록이 있는 경우,
        // // 그 시간을 minArrTime에 저장
        // if (
        //   trip[i].stationId in fastestReachedIndsByStation &&
        //   reachedInfos[fastestReachedIndsByStation[trip[i].stationId]][
        //     trip[i].stationId
        //   ].arrTime < minArrTime
        // ) {
        //   minArrTime =
        //     reachedInfos[fastestReachedIndsByStation[trip[i].stationId]][
        //       trip[i].stationId
        //     ].arrTime;
        // }

        // 이번 iteration에서 이 역에 도달하여 기록된 arrTime이 있는 경우 (아직 최소 시간과 비교되지 않음),
        // 최소 도달 시간과 비교하여 그 시간을 minArrTime에 저장
        if (
          // transportNum != fastestReachedIndsByStation[trip[i].stationId] &&
          trip[i].stationId in reachedInfos[transportNum] &&
          reachedInfos[transportNum][trip[i].stationId].arrTime < minArrTime
        ) {
          minArrTime = reachedInfos[transportNum][trip[i].stationId].arrTime;
        }

        // if (!checkIsBusStation(startStation) && transportNum != 1)
        //   console.log(
        //     // trip,
        //     transportNum,
        //     stationInfos[trip[i].stationId].stationName,
        //     route,
        //     trip[i].arrTime < minArrTime
        //   );

        // 이전까지의 min time들보다 가장 빠르게 도달한 경우, update
        if (trip[i].arrTime < minArrTime) {
          reachedInfos[transportNum][trip[i].stationId] = {
            arrTime: trip[i].arrTime,
            walkingTime:
              reachedInfos[transportNum - 1][startStation].walkingTime,
            index: i,
            prevStationId: parseInt(startStation),
            prevRouteId: route,
            prevIndex: startStationInd,
          };

          // fastestReachedIndsByStation[trip[i].stationId] = transportNum;
          markedStations.add(trip[i].stationId);
        }

        prevArrTime = trip[i].arrTime;

        // // 더 빠른 시간에 열차 탑승이 가능한 경우 (이번역에 이 전 시간에 도착한 기록이 있는 경우),
        // // 이전 시간에 대한 trip을 사용해서 이동하도록 함
        // // but 그냥 이전에 이거보다 빨리 도착했으면 그냥 for 탈출하는게 이득일 것
        // if (
        //   transportNum > 0 &&
        //   trip[i].stationId in reachedInfos[transportNum - 1] &&
        //   reachedInfos[transportNum - 1][trip[i].stationId].arrTime <
        //     trip[i].arrTime
        // ) {
        //   ({ trip, startStationInd } = getNowTrip({
        //     route,
        //     trip: tripsByRoute[route],
        //     station: trip[i].stationId,
        //     term: route in busRouteInfos ? busRouteInfos[route].term : -1,
        //     arrTime: reachedInfos[transportNum - 1][trip[i].stationId].arrTime,
        //   }));

        //   // startStation, startStationInd 변경 필요
        //   startStation = trip[i].stationId;
        //   startStationInd = i;
        // }
      }
    }

    // 도보 이동
    // 그냥 한/인접한 geohash에서 남은 도보 시간만큼 인접 geohash까지 이동 가능
    let footReachedInfo;
    ({ markedStations, footReachedInfo } = getNextInfos({
      markedStations,
      reachedInfo: reachedInfos[transportNum],
      stationInfos,
      stationsByGeohash,
      radius: maxWalkingPerEachStep * walkingUnit,
      walkingUnit,
    }));
    reachedInfos[transportNum] = footReachedInfo;

    // 표시된 역 없는 경우 종료
    if (markedStations.size === 0 || transportNum === maxTransfer) {
      break;
    } else {
      reachedInfos.push({});
    }
  }

  return { reachedInfos, transferNum: transportNum - 1 };
};

// *** raptor 결과 -> 경로
const mkPaths = ({
  // *** 경로 만들 데이터
  startTime,
  reachedInfos,
  transferNum,
  endMarkedStations,
  isLastWalking = true,
  startLat,
  startLng,
  endLat,
  endLng,
  // *** 경로 세부정보 추가를 위한 데이터
  stationInfos,
  additionalTrainCostByStatNames,
  tripsByRoute,
  busRouteInfos,
  // *** alg setting
  walkingUnit,
  taxiUnit,
}) => {
  startLat = parseFloat(startLat);
  startLng = parseFloat(startLng);
  endLat = parseFloat(endLat);
  endLng = parseFloat(endLng);

  const paths = [];

  // 환승이 적은 것부터,
  for (let i = 1; i <= transferNum + 1; i++) {
    // console.log("i =", i);
    // 도착역에서부터 거슬러 올라가며, 각 역에서의 정보 확인
    for (const endStation of endMarkedStations) {
      if (!(endStation in reachedInfos[i])) continue;

      let dropFlag = false; // trip이 없는 경우

      // j번 환승을 통해 station에 도달한 경우
      const nowPath = {
        info: {
          totalWalkTime: reachedInfos[i][endStation].walkingTime,
          totalTaxiTime: 0,
          payment: 0,
          taxiPayment: 0,
          transportPayment: 0,
        },
        subPath: [],
      };

      let lastReachedInfo = reachedInfos[i][endStation],
        // 마지막 역부터 첫 역까지 (실제 path와 반대 순서로) 보게 됨
        // prev가 now보다 더 일찍 도착한 역이 되게 됨
        nowReachedInfo = lastReachedInfo,
        prevReachedInfo;
      let nowStation = endStation;

      // console.log("start ----------");
      // 마지막 역부터 시작해서, 출발지 도달 직전까지 for문 돌며 계산
      for (let j = i; j >= 0; j--) {
        if (nowReachedInfo.prevStationId === null) {
          // 출발지에서 처음으로 도달한 역 도착
          break;
        }

        // 도보 이동 case
        if (nowReachedInfo.prevRouteId === WALKING_ROUTE_ID) {
          // 도보 이동 시에는 transfer 개수를 늘리지 않았음 -> 같은 j
          prevReachedInfo = reachedInfos[j][nowReachedInfo.prevStationId];
          // console.log("prev -> now 도보 이동");
          // console.log("prev", j, prevReachedInfo);
          // console.log("now", j, nowReachedInfo);

          // 도보 이동
          nowPath.subPath.unshift({
            trafficType: TRANSFER_WALKING_CODE,
            sectionTime:
              nowReachedInfo.walkingTime - prevReachedInfo.walkingTime,
            departureTime: prevReachedInfo.arrTime,
            arrivalTime: nowReachedInfo.arrTime,
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            endName: stationInfos[nowStation].stationName,
            endX: stationInfos[nowStation].lng,
            endY: stationInfos[nowStation].lat,
          });

          // prev를 now로 update
          nowStation = nowReachedInfo.prevStationId;
          nowReachedInfo = prevReachedInfo;
        }

        // 대중교통 이용한 이동 시에는 transfer 개수를 늘렸었음 -> j - 1
        prevReachedInfo = reachedInfos[j - 1][nowReachedInfo.prevStationId];

        // console.log("prev -> now 대중교통 이동");
        // console.log("prev", j - 1, prevReachedInfo);
        // console.log("now", j, nowReachedInfo);

        // 한 대중교통 이동의 세부 경로 생성
        const { trip } = getNowTrip({
          trip: tripsByRoute[nowReachedInfo.prevRouteId],
          station: nowReachedInfo.prevStationId,
          term:
            nowReachedInfo.prevRouteId in busRouteInfos
              ? busRouteInfos[nowReachedInfo.prevRouteId].term
              : -1,
          arrTime: prevReachedInfo.arrTime,
        });

        // if (trip === null) {
        //   // trip이 없는 상황
        //   if (!checkIsBusStation(nowReachedInfo.prevStationId))
        //     console.log(
        //       "지하철 path 없음",
        //       stationInfos[nowReachedInfo.prevStationId].stationName
        //     );
        //   dropFlag = true;
        //   break;
        // }

        const passStopList = { stations: [] };
        const term =
          trip[nowReachedInfo.prevIndex].arrTime - prevReachedInfo.arrTime; // 추후 departureTime = 직전 arrTime + term 으로 계산할 예정

        let stationOrder = 0; // 역의 순서
        let prevStationId = null;

        // 탑승한 역의 index에서부터, 하차한 역의 index까지
        for (let k = nowReachedInfo.prevIndex; k <= nowReachedInfo.index; k++) {
          if (prevStationId == trip[k].stationId) continue; // trip에 중복역 연속으로 존재하는 경우, skip
          if (!(trip[k].stationId in stationInfos)) {
            dropFlag = true;
            break;
          }

          // 중복되지 않는 경우 push
          passStopList.stations.push({
            index: stationOrder,
            stationName: stationInfos[trip[k].stationId].stationName,
            arrivalTime: trip[k].arrTime,
            x: String(stationInfos[trip[k].stationId].lng),
            y: String(stationInfos[trip[k].stationId].lat),
          });

          if (checkIsBusStation(trip[k].stationId)) {
            passStopList.stations[stationOrder].localStationID =
              trip[k].stationId;
          } else {
            passStopList.stations[stationOrder].stationID = trip[k].stationId;
          }

          prevStationId = trip[k].stationId;
          stationOrder++;
        }

        // 대중교통별 정보 추가
        if (checkIsBusStation(nowStation)) {
          // 버스
          nowPath.subPath.unshift({
            trafficType: BUS_CODE,
            sectionTime:
              nowReachedInfo.arrTime - (prevReachedInfo.arrTime + term),
            stationCount: stationOrder - 1,
            lane: [
              {
                busNo: busRouteInfos[nowReachedInfo.prevRouteId].routeName,
                type: getBusType(
                  busRouteInfos[nowReachedInfo.prevRouteId].routeName
                ),
                busLocalBlID: nowReachedInfo.prevRouteId,
                departureTime: prevReachedInfo.arrTime + term,
                arrivalTime: nowReachedInfo.arrTime,
              },
            ],
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            startLocalStationID: nowReachedInfo.prevStationId,
            endName: stationInfos[nowStation].stationName,
            endX: stationInfos[nowStation].lng,
            endY: stationInfos[nowStation].lat,
            endLocalStationID: nowStation,
            passStopList,
          });
        } else {
          // 지하철
          nowPath.subPath.unshift({
            trafficType: TRAIN_CODE,
            stationCount: stationOrder - 1,
            sectionTime:
              nowReachedInfo.arrTime - (prevReachedInfo.arrTime + term),
            lane: [
              {
                name: getTrainRouteName(nowReachedInfo.prevRouteId), // (-1, -2 제거)
                subwayCode: getTrainCode(nowReachedInfo.prevRouteId),
                departureTime: prevReachedInfo.arrTime + term,
                arrivalTime: nowReachedInfo.arrTime,
              },
            ],
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            startStationID: nowReachedInfo.prevStationId,
            endName: stationInfos[nowStation].stationName,
            endX: stationInfos[nowStation].lng,
            endY: stationInfos[nowStation].lat,
            endStationID: nowStation,
            way: stationInfos[nowStation].stationName,
            wayCode: getWayCode(nowReachedInfo.prevRouteId),
            passStopList,
          });
        }

        nowStation = nowReachedInfo.prevStationId;
        nowReachedInfo = prevReachedInfo;
      }

      if (dropFlag) continue;

      // 첫역 -> 출발지 정보 추가
      let dist = calcDist({
        startLat,
        startLng,
        endLat: stationInfos[nowStation].lat,
        endLng: stationInfos[nowStation].lng,
      });
      nowPath.subPath.unshift({
        departureTime: startTime,
        arrivalTime: nowReachedInfo.arrTime,
        startX: startLng,
        startY: startLat,
        startName: "출발지",
        endX: stationInfos[nowStation].lng,
        endY: stationInfos[nowStation].lat,
        endName: stationInfos[nowStation].stationName,
      });

      if (nowReachedInfo.prevRouteId === WALKING_ROUTE_ID) {
        nowPath.subPath[0] = {
          trafficType: WALKING_CODE,
          sectionTime: nowReachedInfo.walkingTime,
          ...nowPath.subPath[0],
        };
      } else {
        // taxiRouteId
        nowPath.subPath[0] = {
          trafficType: TAXI_CODE,
          sectionTime: nowReachedInfo.taxiTime,
          taxiPayment: getTaxiCostFromDist({
            dist,
            arrTime: nowPath.subPath[0].arrivalTime,
          }),
          ...nowPath.subPath[0],
        };

        nowPath.info.totalTaxiTime += nowPath.subPath[0].sectionTime;
        nowPath.info.taxiPayment += nowPath.subPath[0].taxiPayment;
        nowPath.info.payment += nowPath.subPath[0].taxiPayment;
      }

      // 도착지 -> 마지막역 정보 추가
      dist = calcDist({
        startLat: stationInfos[endStation].lat,
        startLng: stationInfos[endStation].lng,
        endLat,
        endLng,
      });
      sectionTime = getTimeFromDist({
        dist,
        walkingUnit,
        taxiUnit,
        isWalking: isLastWalking,
      });

      const lastSubPathInd = nowPath.subPath.length;
      nowPath.subPath.push({
        sectionTime,
        departureTime: lastReachedInfo.arrTime,
        arrivalTime: lastReachedInfo.arrTime + sectionTime,
        startX: stationInfos[endStation].lng,
        startY: stationInfos[endStation].lat,
        endX: endLng,
        endY: endLat,
        startName: stationInfos[endStation].stationName,
        endName: "도착지",
      });

      if (isLastWalking) {
        nowPath.subPath[lastSubPathInd] = {
          trafficType: WALKING_CODE,
          ...nowPath.subPath[lastSubPathInd],
        };

        // 도보 이동시간 추가
        nowPath.info.totalWalkTime +=
          nowPath.subPath[lastSubPathInd].sectionTime;
      } else {
        // taxiRouteId
        nowPath.subPath[lastSubPathInd] = {
          trafficType: TAXI_CODE,
          ...nowPath.subPath[lastSubPathInd],
          taxiPayment: getTaxiCostFromDist({
            dist,
            arrTime: nowPath.subPath[lastSubPathInd].arrivalTime,
          }),
        };

        // 택시 이동시간 추가
        nowPath.info.totalTaxiTime +=
          nowPath.subPath[lastSubPathInd].sectionTime;
        nowPath.info.taxiPayment += nowPath.subPath[lastSubPathInd].taxiPayment;
        nowPath.info.payment += nowPath.subPath[lastSubPathInd].taxiPayment;
      }

      // // 대중교통 비용 계산
      // const transportPayment = calcTransportCost({
      //   path: nowPath,
      //   stationInfos,
      //   additionalTrainCostByStatNames,
      // });
      // nowPath.info.transportPayment = transportPayment;
      // nowPath.info.payment += transportPayment;

      // 첫 역 정보를 알아야지만 계산 가능한 정보 추가
      nowPath.info = {
        ...nowPath.info,
        departureTime: startTime,
        arrivalTime: nowPath.subPath[lastSubPathInd].arrivalTime,
        transferCount: i - 1,
        firstStartStation: stationInfos[nowStation].stationName,
        lastEndStation: stationInfos[endStation].stationName,
        totalTime: nowPath.subPath[lastSubPathInd].arrivalTime - startTime,
      };

      // path 정보 추가
      paths.push(nowPath);
    }
  }

  return paths;
};

const selectAndSortPaths = ({
  paths,
  // *** alg setting
  maxCost,
  maxWalking,
  isIncludeTaxi,
}) => {
  // 1. 지났던 역 중복으로 지나는 경로 추려내기
  paths.filter((path) => {
    const middleStationSet = new Set(),
      startStationSet = new Set(),
      endStationSet = new Set();

    for (const subPath of path.subPath) {
      if (
        !(
          subPath.trafficType === BUS_CODE || subPath.trafficType === TRAIN_CODE
        )
      )
        continue;

      // 대중교통 탈 때, 동일 역을 이전에 지난 적 있으면 안 됨 (반복하여 동일 역 지나가는 비효율적인 경로)
      // or, 전 단계에서 이미 endStation에 포함된 역 있다면 drop
      for (let j = 0; j < subPath.passStopList.stations.length; j++) {
        const station =
          subPath.trafficType === BUS_CODE
            ? subPath.passStopList.stations[j].localStationID
            : subPath.passStopList.stations[j].stationID;
        if (
          middleStationSet.has(station) ||
          // 출발-도착역 pair의 경우 문제 X
          (j == 0 && startStationSet.has(station)) ||
          (j == subPath.passStopList.stations.length - 1 &&
            endStationSet.has(station)) ||
          (!(j == 0 || j == subPath.passStopList.stations.length - 1) &&
            (startStationSet.has(station) || endStationSet.has(station)))
        ) {
          return false;
        }

        if (j == 0) startStationSet.add(station);
        else if (j == subPath.passStopList.stations.length - 1)
          endStationSet.add(station);
        else middleStationSet.add(station);
      }
    }

    return true;
  });

  // 2. 동일 노선 연속으로 또 타는 문제 해결
  paths = paths.filter((path) => {
    let prevRouteType = null,
      prevRouteName = null;

    for (const subPath of path.subPath) {
      if (
        !(
          subPath.trafficType === BUS_CODE || subPath.trafficType === TRAIN_CODE
        )
      )
        continue;

      if (
        prevRouteType === subPath.trafficType &&
        prevRouteName === (subPath.trafficType === BUS_CODE)
          ? subPath.lane[0].busNo
          : subPath.lane[0].name
      ) {
        return false;
      }

      prevRouteType = subPath.trafficType;
      prevRouteName =
        subPath.trafficType === BUS_CODE
          ? subPath.lane[0].busNo
          : subPath.lane[0].name;
    }

    return true;
  });

  // TODO: 중복 노선 제거 (출발 -> 끝 역만 미세하게 다르고 동일 노선 타는 수많은 case들)

  // 3. 최대 도보 넘는 거 제거
  paths = paths.filter((path) => {
    return path.info.totalWalkTime <= maxWalking;
  });

  // 4. 정렬
  paths.sort((path1, path2) => {
    // 1. (isIncludeTaxi = true인 경우) 택시비 최소
    if (isIncludeTaxi && path1.info.taxiPayment != path2.info.taxiPayment)
      return path1.info.taxiPayment - path2.info.taxiPayment;

    // 2. 택시비 동일한 경우, 더 빠른 도착시간
    if (path1.info.totalTime != path2.info.totalTime)
      return path1.info.totalTime - path2.info.totalTime;

    // 3. 시간 동일한 경우, 환승 적은 것
    return path1.info.transferCount - path2.info.transferCount;
  });

  return paths;
};

const addRealtimeInfos = async ({ startDate, paths }) => {
  try {
    paths = await Promise.all(
      paths.map((path) => {
        // 각 경로에 대해, realtime path 계산
        return addEachRealtimeInfo({ startDate, path });
      })
    );
  } catch (err) {
    throw err;
  }

  return paths;
};

const addEachRealtimeInfo = async ({ startDate, path }) => {
  const {
    SK_KEY,
    SK_WALKING_URL,
    SK_TAXI_URL,
    REALTIME_TRAIN_STATION_URL,
    REALTIME_TRAIN_ROUTE_URL,
    REATIME_BUS_ROUTE_URL,
  } = process.env;

  const newPath = { ...path, subPath: [] };
  newPath.info = {
    ...newPath.info,
    totalWalkTime: 0,
    totalTaxiTime: 0,
    payment: 0,
    taxiPayment: 0,
  };

  let departureTime,
    arrivalTime,
    diff = 0;

  // subPath를 순차적으로 방문하며, 실제 도보/택시 시간으로 보정
  for (const subPath of path.subPath) {
    let newSubPath;

    if (
      subPath.trafficType === WALKING_CODE ||
      subPath.trafficType === TRANSFER_WALKING_CODE
    ) {
      // 도보
      // TODO: 코드 분리 (API 호출부와 아닌 부분)
      const tmapBody = qs.stringify({
          ...subPath,
        }),
        config = {
          headers: {
            appKey: SK_KEY,
          },
        };

      try {
        const response = await axios
          .post(SK_WALKING_URL, tmapBody, config)
          .then(({ data }) => {
            return data;
          });

        newSubPath = {
          ...subPath,
          steps: response.features.map((el) => {
            return { type: el.type, geometry: el.geometry };
          }),
          // .filter((el) => el.geometry.type === "LineString"),
          distance: response.features[0].properties.totalDistance,
          sectionTime: Math.round(
            response.features[0].properties.totalTime / 60
          ),
        };
      } catch (err) {
        throw err;
      }

      ({ departureTime, arrivalTime, diff } = updateTime({
        departureTime: newSubPath.departureTime,
        arrivalTime: newSubPath.arrivalTime,
        diff,
        sectionTime: newSubPath.sectionTime,
        startDate,
      }));

      newSubPath.departureTime = departureTime;
      newSubPath.arrivalTime = arrivalTime;

      newPath.info.totalWalkTime += newSubPath.sectionTime;
    } else if (subPath.trafficType === TAXI_CODE) {
      // 택시
      const tmapBody = qs.stringify({
          ...subPath,
          // TODO: gpsTime 넣어주기
        }),
        config = {
          headers: {
            appKey: SK_KEY,
          },
        };

      try {
        const response = await axios
          .post(SK_TAXI_URL, tmapBody, config)
          .then(({ data }) => {
            return data;
          });

        newSubPath = {
          ...subPath,
          steps: response.features.map((el) => {
            return { type: el.type, geometry: el.geometry };
          }),
          distance: response.features[0].properties.totalDistance,
          sectionTime: Math.round(
            response.features[0].properties.totalTime / 60
          ),
          taxiPayment: response.features[0].properties.taxiFare,
        };
      } catch (err) {
        throw err;
      }

      ({ departureTime, arrivalTime, diff } = updateTime({
        departureTime: newSubPath.departureTime,
        arrivalTime: newSubPath.arrivalTime,
        diff,
        sectionTime: newSubPath.sectionTime,
        startDate,
      }));

      newSubPath.departureTime = departureTime;
      newSubPath.arrivalTime = arrivalTime;
      newSubPath.taxiPayment *= calcExtraTaxiCostPercentage(departureTime);

      newPath.info.totalTaxiTime += newSubPath.sectionTime;
      newPath.info.taxiPayment += newSubPath.taxiPayment;
      newPath.info.payment += newSubPath.taxiPayment;
    } else {
      // 대중교통
      // TODO: 실시간 도착정보 추가

      newSubPath = {
        ...subPath,
      };

      ({ departureTime, arrivalTime, diff } = updateTime({
        departureTime: newSubPath.lane[0].departureTime,
        arrivalTime: newSubPath.lane[0].arrivalTime,
        diff,
        sectionTime: newSubPath.sectionTime,
        startDate,
      }));

      newSubPath.lane[0].departureTime = departureTime;
      newSubPath.lane[0].arrivalTime = arrivalTime;

      newSubPath.passStopList.stations = newSubPath.passStopList.stations.map(
        (station) => {
          return {
            ...station,
            arrivalTime: station.arrivalTime + diff,
          };
        }
      );
    }

    newPath.subPath.push(newSubPath);
  }

  newPath.info.departureTime = getDateStrFromTime({
    time: newPath.info.departureTime,
    date: startDate,
  });
  newPath.info.arrivalTime = arrivalTime;

  return newPath;
};

// *** departureTime, arrivalTime을 update해주는 함수
const updateTime = ({
  departureTime,
  arrivalTime,
  diff,
  sectionTime,
  startDate,
}) => {
  let newDepartureTime = departureTime + diff;
  let newArrivalTime = newDepartureTime + sectionTime;
  diff += newArrivalTime - arrivalTime; // 즉, 실제 지연되는 시간 (더해줘야 함)

  newDepartureTime = getDateStrFromTime({
    time: newDepartureTime,
    date: startDate,
  });
  newArrivalTime = getDateStrFromTime({
    time: newArrivalTime,
    date: startDate,
  });

  return { departureTime: newDepartureTime, arrivalTime: newArrivalTime, diff };
};

const getDateStrFromTime = ({ time, date }) => {
  const newDate = getDateFromTime({
    time,
    date,
  });

  return new Date(newDate.getTime() - newDate.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, -5);
};

// *** date, time 관련 함수들
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
    solarHoliday.has(getDateStringToDate(date)) ||
    lunarHoliday.has(getDateStringToDate(date))
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
  let week = date.getDay();
  if (date.getHours() < 10) {
    // 10시 미만이면, 이전 날로 취급
    week -= 1;

    if (week < 0) week = 6;
  }

  return week;
};

const getTrainWeekFromDate = (date) => {
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

const getBusWeekFromDate = (date) => {
  if (checkIsHoliday(date)) return "holiday";

  const week = getWeekFromDate(date);

  let busWeek;
  if (week >= 0 && week <= 4) {
    busWeek = "day";
  } else if (week === 5) {
    busWeek = "sat";
  } else {
    busWeek = "holiday";
  }

  return busWeek;
};

const getTimeFromDate = (date) => {
  let time = date.getHours() * 60 + date.getMinutes();

  if (time < 10 * 60) {
    time += 24 * 60;
  }

  return time;
};

const getDateFromTime = ({ time, date }) => {
  const startTime = getTimeFromDate(date);

  if (time >= 24 * 60) {
    time -= 24 * 60;
    if (startTime < 24 * 60) {
      // date + 1 (하루 지남)
      date.setDate(date.getDate() + 1);
    }
  }

  date.setHours(Math.floor(time / 60), time % 60);

  return date;
};

// *** DB에서 데이터 불러오는 함수들
const getEnableStationsFromDB = async () => {
  let conn = null;

  const stationsByGeohash = {},
    stationInfos = {},
    additionalTrainCostByStatNames = {};

  try {
    conn = await mysql.getConnection();

    const sql_train = `
      SELECT *
      FROM train_station
      `;
    // const sql_train_cost = `
    //   SELECT *
    //   FROM train_cost
    //   `;
    const sql_bus = `
      SELECT *
      FROM bus_station
      `;

    const [train, bus] = await Promise.all([
      conn.query(sql_train),
      // conn.query(sql_train_cost),
      conn.query(sql_bus),
    ]);

    conn.release();

    // cost
    // for (const info of train_cost[0]) {
    //   if (!(info.start_stat_name in additionalTrainCostByStatNames)) {
    //     additionalTrainCostByStatNames[info.start_stat_name] = {};
    //   }

    //   additionalTrainCostByStatNames[info.start_stat_name][info.end_stat_name] =
    //     info.cost;
    // }

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

  return { stationsByGeohash, stationInfos, additionalTrainCostByStatNames };
};

const getEnableRoutesFromDB = async (startDate) => {
  let conn = null;
  let result = {};

  const busWeek = getBusWeekFromDate(startDate),
    trainWeek = getTrainWeekFromDate(startDate);

  try {
    conn = await mysql.getConnection();

    const sql_train_trip = `
      SELECT *
      FROM train_time
      WHERE week ${trainWeek == 1 ? " = 1" : " >= 2"}
    `;
    const sql_train_route = `
      SELECT *
      FROM train_route 
      WHERE week ${trainWeek == 1 ? " = 1" : " >= 2"}
    `;
    const sql_bus_trip = `
      SELECT *
      FROM bus_last_time
    `;
    const sql_bus_term = `
      SELECT route_id, route_name, ${busWeek} as term
      FROM bus_term
    `;

    const [train_trip, train_route, bus_trip, bus_term] = await Promise.all([
      conn.query(sql_train_trip),
      conn.query(sql_train_route),
      conn.query(sql_bus_trip),
      conn.query(sql_bus_term),
    ]);

    conn.release();

    // 토요일과(2) 일/공휴일(3)을 구분하는 노선들
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

    const trainRouteIdByTrainId = {},
      routesByStation = {},
      tripsByTrainRoute = {},
      tripsByBusRoute = {},
      busRouteInfos = {};

    for (const info of train_route[0]) {
      if (routeIncludesWeek3.has(info.route_name) && info.week != trainWeek) {
        // 필요없는 정보
        continue;
      }

      const id = getTrainRouteId({
        routeName: info.route_name,
        inout: info.way,
        startStationId: info.start_stat_id,
        endStationId: info.end_stat_id,
        isDirect: info.is_direct,
      });

      // // check해보기 => 중복 뜨는지
      // // 확인 결과, 없음
      // if (
      //   info.route_name + "-" + info.way + "-" + info.train_id in
      //   trainRouteIdByTrainId
      // ) {
      //   console.log("중복 존재");
      // }

      trainRouteIdByTrainId[
        info.route_name + "-" + info.way + "-" + info.train_id
      ] = id;
    }

    for (const info of train_trip[0]) {
      if (routeIncludesWeek3.has(info.route_name) && info.week != trainWeek) {
        // 필요없는 정보
        continue;
      }

      const id =
        trainRouteIdByTrainId[
          info.route_name + "-" + info.way + "-" + info.train_id
        ];

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
      busRouteInfos[info.route_id] = {
        term: info.term,
        routeName: info.route_name,
      };
    }

    const tripsByRoute = { ...tripsByTrainRoute, ...tripsByBusRoute };

    result = {
      routesByStation,
      tripsByRoute,
      busRouteInfos,
    };
  } catch (err) {
    if (conn !== null) conn.release();
    console.log(err);
  }

  return result;
};

// *** tripsByRoute에 사용할, 지하철 노선 + inout + 첫열차 끝열차 + 급행여부 로 id 생성하는 함수
const getTrainRouteId = ({
  routeName,
  inout,
  startStationId,
  endStationId,
  isDirect,
}) => {
  return (
    routeName +
    "-" +
    String(inout) +
    "-" +
    startStationId +
    "-" +
    endStationId +
    "-" +
    String(isDirect)
  );
};

// *** 버스 정류장인지 지하철 정류장인지 확인하는 함수
const checkIsBusStation = (id) => {
  if (parseInt(id) >= 100000000) return true;

  return false;
};

// *** 버스 노선 코드 리턴해주는 함수
const getBusType = (busNo) => {
  const busCodeDict = {
    일반: 1,
    좌석: 2,
    마을버스: 3,
    직행좌석: 4,
    공항버스: 5,
    간선급행: 6,
    외곽: 10,
    간선: 11,
    지선: 12,
    순환: 13,
    광역: 14,
    급행: 15,
    관광버스: 16,
    농어촌버스: 20,
    "경기도 시외형버스": 22,
    급행간선: 26,
  };

  // const airportBusList = ["6000", "6001", "6002", "6003", "6004", "6005", "6006", "6008", "6009", "6010", "6011", "6012", "6013", "6014", "6015", "6016", "6017", "6018", "6020", "6030", "6100", "6101", "6200", "6300", "6701", "6702", "6703", "6704", "6705", "6706", "6707A"];

  if (isNaN(busNo.slice(1, -1))) {
    // 1. 이름 양끝을 제거해도 문자 포함된 경우 -> 마을버스
    return busCodeDict["마을버스"];
  } else if (busNo.length === 5 && busNo[0] === "N") {
    return busCodeDict["공항버스"];
  } else if ((busNo.length === 4 && busNo[0] === "9") || busNo[0] === "M") {
    // M버스도 여기 포함
    return busCodeDict["광역"];
  } else if (busNo.length === 4) {
    return busCodeDict["지선"];
  } else if (busNo.length === 3) {
    // 심야버스(N--)도 여기 포함
    return busCodeDict["간선"];
  } else if (busNo.length === 2) {
    return busCodeDict["순환"];
  }

  return busCodeDict["일반"];
};

const getTrainRouteName = (trainRouteName) => {
  const strs = trainRouteName.split("-");
  return strs[0];
};

const getTrainCode = (trainRouteName) => {
  const routeName = getTrainRouteName(trainRouteName);

  const trainCodeDict = {
    "수도권 1호선": 1,
    "수도권 2호선": 2,
    "수도권 3호선": 3,
    "수도권 4호선": 4,
    "수도권 5호선": 5,
    "수도권 6호선": 6,
    "수도권 7호선": 7,
    "수도권 8호선": 8,
    "수도권 9호선": 9,
    공항철도: 101,
    자기부상철도: 102,
    경의중앙선: 104,
    에버라인: 107,
    경춘선: 108,
    신분당선: 109,
    의정부경전철: 110,
    경강선: 112,
    우이신설선: 113,
    서해선: 114,
    김포골드라인: 115,
    수인분당선: 116,
    신림선: 117,
  };

  return trainCodeDict[routeName];
};

const getWayCode = (trainRouteName) => {
  const strs = trainRouteName.split("-");
  return parseInt(strs[1]);
};

// *** arrTime에 맞는 trip 정보 가져오는 함수
const getNowTrip = ({ route, trip, station, term = 15, arrTime }) => {
  // TODO: 배차간격 없는 경우 일단 15분으로 처리해둠, 평균 확인해보기 -> X 걍 상수 처리나 나중에 하기
  // or, 버스 종류별로 평균 배차간격 정해주는 것도 좋을 듯

  if (checkIsBusStation(station)) {
    // 버스
    // 배차간격 -1일 경우, 해당 요일에 운영 X
    if (term === -1) return { trip: null };

    // 첫 정류장에 대한 해당 노선 경로에서의 index
    const startStationInd = trip.findIndex((el) => el.stationId == station);

    // 정류장을 지나지 않는 경우 (오류 case)
    if (startStationInd === -1) return { trip: null };

    // 1. 막차 시간 - 탑승 가능 시간 계산
    let diff = trip[startStationInd].arrTime - arrTime;

    // 막차 시간을 이미 지났으면 탑승 불가
    if (diff < 0) return { trip: null };
    // diff가 배차 간격보다 크게 차이나는 경우, 막차가 아닌 다른 차 타게 됨
    // (즉, 정확히 언제 차가 도착하는지 확신하기 어려움, 이 경우 최대 term만큼을 대기한 뒤 버스를 탑승하게 될 것)
    if (diff > term) diff -= term;

    // 2. 정류장에 도착한 뒤, 배차 간격만큼 대기 후 오는 차를 타도록 함
    // 이때, 배차 간격을 기다릴 필요 없음
    let newTrip = trip.map((el) => {
      return {
        arrTime: el.arrTime - diff,
        stationId: el.stationId,
        order: el.order,
      };
    });

    return { trip: newTrip, startStationInd };
  } else {
    // 지하철
    // 1. 가장 가까운 정보 찾기
    let selectedTrainId = -1,
      selectedStationInd = -1,
      minArrTime = 100 * 60;

    for (const trainId in trip) {
      const startStationInd = trip[trainId].findIndex(
        (el) => el.stationId == station
      );

      // 이런 차가 없으면, break
      if (startStationInd === -1) continue;
      // 마지막 역이면 break
      if (startStationInd === trip[trainId].length - 1) continue;

      // 내가 탑승 가능한 시간에서부터 얼마나 걸리는지
      if (
        trip[trainId][startStationInd].arrTime < minArrTime &&
        trip[trainId][startStationInd].arrTime > arrTime
      ) {
        selectedTrainId = trainId;
        selectedStationInd = startStationInd;
        minArrTime = trip[trainId][startStationInd].arrTime;
      }
    }

    if (selectedTrainId === -1) return { trip: null };
    return { trip: trip[selectedTrainId], startStationInd: selectedStationInd };
  }
};

// *** 첫 위치에서 도보 이동 가능 (or 택시 이동 가능) 역들 이동하는 함수
const getInitInfos = ({
  // startGeohash,
  startLat,
  startLng,
  startTime,
  stationInfos,
  stationsByGeohash,
  radius,
  walkingRadius, // isWalking = false에만 필요
  walkingUnit,
  taxiUnit, // isWalking = false에만 필요
  isWalking = true,
}) => {
  let markedStations = new Set();
  let initReachedInfo = {};
  // console.log(startLat, startLng);

  const circleStations = getCircleGeohash({
    // centerGeohash: startGeohash,
    centerLat: startLat,
    centerLng: startLng,
    stationsByGeohash,
    stationInfos,
    radius,
    walkingUnit,
    taxiUnit,
    isWalking,
  });

  for (const station in circleStations) {
    // if (stationsByGeohash[station] === undefined) {
    //   continue;
    // }

    markedStations = new Set([...markedStations, station]);

    // for (const station of stationsByGeohash[station]) {
    const arrTime = startTime + circleStations[station];

    if (isWalking) {
      initReachedInfo[station] = {
        arrTime,
        walkingTime: circleStations[station],
        prevStationId: null,
        prevRouteId: WALKING_ROUTE_ID,
      };
    } else {
      initReachedInfo[station] = {
        arrTime,
        walkingTime: 0,
        taxiTime: circleStations[station],
        prevStationId: null,
        prevRouteId: TAXI_ROUTE_ID,
      };
    }
    // }
  }

  // taxi로 빼게 될 경우
  if (!isWalking) {
    const {
      markedStations: walkingMarkedStations,
      initReachedInfo: walkingInitReachedInfo,
    } = getInitInfos({
      // startGeohash,
      startLat,
      startLng,
      startTime,
      stationsByGeohash,
      stationInfos,
      radius: walkingRadius,
      walkingUnit,
    });

    markedStations = new Set(
      [...markedStations].filter((el) => !walkingMarkedStations.has(el))
    );

    const newInitReachedInfo = {};
    for (el in initReachedInfo) {
      if (!(el in walkingInitReachedInfo)) {
        newInitReachedInfo[el] = initReachedInfo[el];
      }
    }
    initReachedInfo = newInitReachedInfo;
  }

  return { markedStations, initReachedInfo };
};

// *** 도착으로 허용할 마지막 도착역들 목록 생성
const getFinalInfo = ({
  // endGeohash,
  endLat,
  endLng,
  stationInfos,
  stationsByGeohash,
  radius,
  walkingRadius,
  walkingUnit,
  taxiUnit,
  isWalking = true,
}) => {
  let markedStations = new Set();

  // console.log(endLat, endLng);
  const circleStations = getCircleGeohash({
    // centerGeohash: endGeohash,
    centerLat: endLat,
    centerLng: endLng,
    stationInfos,
    stationsByGeohash,
    radius,
    walkingUnit,
    taxiUnit,
    isWalking,
  });

  // for (const hash in circleStations) {
  //   if (stationsByGeohash[hash] === undefined) {
  //     continue;
  //   }

  //   markedStations = new Set([...markedStations, ...stationsByGeohash[hash]]);
  // }

  markedStations = new Set(Object.keys(circleStations));

  // taxi로 빼게 될 경우
  if (!isWalking) {
    const walkingMarkedStations = getFinalInfo({
      // endGeohash,
      endLat,
      endLng,
      stationInfos,
      stationsByGeohash,
      radius: walkingRadius,
      walkingUnit,
    });

    markedStations = new Set(
      [...markedStations].filter((el) => !walkingMarkedStations.has(el))
    );
  }

  return markedStations;
};

// *** 도보 이동 가능 역들 이동하는 함수
const getNextInfos = ({
  markedStations,
  reachedInfo,
  stationInfos,
  stationsByGeohash,
  radius,
  walkingUnit,
}) => {
  // 전체 geohash 모으기
  // const markedGeohashes = {};
  // for (const station of markedStations) {
  //   const newHash = geohash.encode(
  //     stationInfos[station].lat,
  //     stationInfos[station].lng,
  //     GEOHASH_LEVEL
  //   );

  //   // 해당 geohash에 가장 빨리 도달한 도달시간, 포함역, 도보 시간들 모으기
  //   if (
  //     !(newHash in markedGeohashes) ||
  //     reachedInfo[station].arrTime < markedGeohashes[newHash].arrTime
  //   ) {
  //     markedGeohashes[newHash] = {
  //       // reachedInfo: reachedInfo[station],
  //       arrTime: reachedInfo[station].arrTime,
  //       stationId: station,
  //       walkingTime: reachedInfo[station].walkingTime,
  //       // taxiTime: reachedInfo[station].taxiTime,
  //     };
  //   }
  // }

  // 각 geohash에서 getCircleGeohash 호출
  // for (const hash in markedGeohashes) {
  for (const startStation of markedStations) {
    const circleStations = getCircleGeohash({
      // centerGeohash: hash,
      centerLat: stationInfos[startStation].lat,
      centerLng: stationInfos[startStation].lng,
      stationInfos,
      stationsByGeohash,
      radius,
      walkingUnit,
    });

    // const hashInfo = markedGeohashes[hash];
    // hash 안에 있는 역들마다, 새 key 저장
    for (const station in circleStations) {
      // 해당 hash의 역 없는 경우
      // if (!(station in stationsByGeohash)) continue;
      // for (const station of stationsByGeohash[station]) {
      if (!(station in reachedInfo)) {
        // 이전까지 도달한 적 없는 역
        reachedInfo[station] = {
          // arrTime: hashInfo.arrTime + circleStations[station],
          // walkingTime: hashInfo.walkingTime + circleStations[station],
          // prevStationId: hashInfo.stationId,
          // prevRouteId: WALKING_ROUTE_ID,

          arrTime: reachedInfo[startStation].arrTime + circleStations[station],
          prevStationId: parseInt(startStation),
          walkingTime:
            reachedInfo[startStation].walkingTime + circleStations[station],
          prevRouteId: WALKING_ROUTE_ID,
        };

        // if (
        //   !checkIsBusStation(station) &&
        //   stationInfos[station].stationName === "가산디지털단지"
        // ) {
        //   console.log("1", reachedInfo[startStation], reachedInfo[station]);
        // }
      }
      // else if (
      //   station !== startStation &&
      //   reachedInfo[station].arrTime >
      //     reachedInfo[startStation].arrTime + circleStations[station]
      // ) {
      //   // 도달한 적 있던 역
      //   // 갱신
      //   // if (
      //   //   !checkIsBusStation(station) &&
      //   //   stationInfos[station].stationName === "가산디지털단지"
      //   // )
      //   //   console.log("before", station, reachedInfo[station]);
      //   reachedInfo[station] = {
      //     // arrTime: hashInfo.arrTime + circleStations[station],
      //     // walkingTime: hashInfo.walkingTime + circleStations[station],
      //     // prevStationId: hashInfo.stationId,
      //     // prevRouteId: WALKING_ROUTE_ID,

      //     arrTime: reachedInfo[startStation].arrTime + circleStations[station],
      //     prevStationId: startStation,
      //     walkingTime:
      //       reachedInfo[startStation].walkingTime + circleStations[station],
      //     prevRouteId: WALKING_ROUTE_ID,
      //   };

      //   // if (
      //   //   !checkIsBusStation(station) &&
      //   //   stationInfos[station].stationName === "가산디지털단지"
      //   // ) {
      //   //   console.log("2", reachedInfo[startStation], reachedInfo[station]);
      //   // }
      // }
      // }
    }
  }

  // mark
  markedStations = new Set([...markedStations, ...Object.keys(reachedInfo)]);

  return {
    markedStations,
    footReachedInfo: reachedInfo,
  };
};

// *** Geohash 관련 함수들
// centerGeohash를 중심으로 radius를 반지름으로 하는 원을 geohash들로 만들어 리턴
const getCircleGeohash = ({
  centerLat,
  centerLng,
  stationsByGeohash,
  stationInfos,
  radius,
  walkingUnit,
  taxiUnit,
  isWalking = true,
}) => {
  const centerGeohash = geohash.encode(centerLat, centerLng, GEOHASH_LEVEL);
  // console.log(centerLat, centerLng);

  let stations = {};
  const geohashes = new Set();

  // ** geohashes
  // { geohash: walkingTime or taxiTime }

  exploreCircle = (hash) => {
    // const neighborPoint = geohash.decode(hash);
    // const centerDist = calcDist({
    //   startLat: centerLat,
    //   startLng: centerLng,
    //   endLat: neighborPoint.latitude,
    //   endLng: neighborPoint.longitude,
    // });

    const neighbors = findNeighbors(hash); // 4방향 이웃 줌

    for (const neighbor of neighbors) {
      const nowStations = {};

      if (!geohashes.has(neighbor)) {
        geohashes.add(neighbor);

        // 해당 역에 해당하는 geohash X
        if (stationsByGeohash[neighbor] === undefined) continue;

        // console.log(stationsByGeohash[neighbor]);
        for (const station of stationsByGeohash[neighbor]) {
          // if (!checkIsBusStation(station)) {
          //   console.log(station);
          // }

          const dist = calcDist({
            startLat: centerLat,
            startLng: centerLng,
            endLat: stationInfos[station].lat,
            endLng: stationInfos[station].lng,
          });

          if (dist < radius)
            nowStations[station] = getTimeFromDist({
              dist,
              walkingUnit,
              taxiUnit,
              isWalking,
            });
        }

        stations = { ...stations, ...nowStations };
        if (Object.keys(nowStations).length !== 0) exploreCircle(neighbor);
      }
    }
  };

  exploreCircle(centerGeohash);
  return stations;
};

const findNeighbors = (hash) => {
  const neighbors = [];

  // 주어진 Geohash를 위경도로 디코드
  const { latitude, longitude } = geohash.decode(hash, GEOHASH_LEVEL);

  // 이웃하는 Geohash의 방향과 거리
  const directions = [
    [1, 0], // 동쪽 (East)
    [-1, 0], // 서쪽 (West)
    [0, 1], // 남쪽 (South)
    [0, -1], // 북쪽 (North)
    [1, 1],
    [-1, -1],
    [-1, 1],
    [1, -1],
  ];
  const distance = 1;

  // 각 방향별로 이웃 Geohash 생성
  for (const [dx, dy] of directions) {
    // console.log(
    //   hash,
    //   geohash.encode(
    //     latitude + dx * distance * 0.006,
    //     longitude + dy * distance * 0.006,
    //     GEOHASH_LEVEL
    //   )
    // );
    neighbors.push(
      geohash.encode(
        latitude + dx * distance * 0.0055,
        longitude + dy * distance * 0.0055,
        GEOHASH_LEVEL
      )
    );
  }

  return neighbors;
};

// *** 거리 계산 함수
const calcDist = ({ startLat, startLng, endLat, endLng }) => {
  const root2 = 1.41421356; // 직선 거리 값을 보정하기 위한 택시 및 도보 가중치

  return (
    haversine(
      {
        latitude: startLat,
        longitude: startLng,
      },
      {
        latitude: endLat,
        longitude: endLng,
      },
      { unit: "meter" }
    ) * root2
  );
};

// *** 거리 <-> 시간 관련 함수
const getTimeFromDist = ({ dist, walkingUnit, taxiUnit, isWalking = true }) => {
  let time;
  if (isWalking) {
    time = Math.round(dist / walkingUnit);
  } else {
    time = Math.round(dist / taxiUnit);
  }

  return time;
};

// *** 대중교통 비용 계산 함수
const calcTransportCost = ({
  path,
  stationInfos,
  additionalTrainCostByStatNames,
}) => {
  const TRAIN_DEFAULT_COST = 1250;

  let cost = 0;
  let transferCnt = 0;
  let defaultCost,
    startStationId,
    endStationId,
    trainFlag = false;

  for (subPath of path.subPath) {
    if (trainFlag && subPath.trafficType !== TRAIN_CODE) {
      // 지하철 간의 환승은 다 끝남, 비용 계산하기
      if (transferCnt % 5 === 0) {
        // 기본 요금 지불 필요
        defaultCost = TRAIN_DEFAULT_COST;
        cost += defaultCost;
      } else if (TRAIN_DEFAULT_COST > defaultCost) {
        // 이전에 지불한 기본요금보다 비쌀 경우, 추가 비용 차감
        cost += TRAIN_DEFAULT_COST - defaultCost;
        defaultCost = TRAIN_DEFAULT_COST;
      }

      // 계산 -> 최단거리비례제도
      // A -> B역으로 가는 최소 거리를 기준으로 비용 산출하게 됨
      console.log(
        "cost",
        stationInfos[startStationId].stationName,
        stationInfos[endStationId].stationName
      );

      let adder;
      if (
        additionalTrainCostByStatNames[
          stationInfos[startStationId].stationName
        ] === undefined
      ) {
        adder =
          additionalTrainCostByStatNames[
            stationInfos[endStationId].stationName
          ][stationInfos[startStationId].stationName];
      } else {
        adder =
          additionalTrainCostByStatNames[
            stationInfos[startStationId].stationName
          ][stationInfos[endStationId].stationName];
      }
      cost += adder - TRAIN_DEFAULT_COST;

      trainFlag = false;
    }

    if (subPath.trafficType === TRAIN_CODE) {
      if (!trainFlag) startStationId = subPath.startStationID;
      endStationId = subPath.endStationID;

      console.log(
        "flag",
        stationInfos[startStationId].stationName,
        stationInfos[endStationId].stationName
      );
      trainFlag = true;
    } else if (subPath.trafficType === BUS_CODE) {
      const busNo = subPath.lane[0].busNo;

      if (transferCnt % 5 === 0) {
        // 기본 요금 지불 필요
        defaultCost = getBusDefaultCost(busNo);
        cost += defaultCost;
      } else if (getBusDefaultCost(busNo) > defaultCost) {
        // 이전에 지불한 기본요금보다 비쌀 경우, 추가 비용 차감
        cost += getBusDefaultCost(busNo) - defaultCost;
        defaultCost = getBusDefaultCost(busNo);
      }

      // 이동거리비례제, 이동거리 추산 필요
      let dist = 0;
      let startLat, startLng, endLat, endLng;
      for (station of subPath.passStopList.stations) {
        if (station.index === 0) {
          startLat = station.y;
          startLng = station.x;
          continue;
        }

        endLat = station.y;
        endLng = station.x;
        dist += calcDist({ startLat, startLng, endLat, endLng });

        startLat = endLat;
        startLng = endLng;
      }

      cost += getAdditionalBusCost(dist);
    }
  }

  return cost;
};

const getBusDefaultCost = (busNo) => {
  if (isNaN(busNo.slice(1, -1))) {
    // 마을
    return 900;
  } else if (busNo.length >= 5 && busNo[0] === "N") {
    // 공항
    if (busNo[2] === "1") return 14000; // N6100 ~ N6103
    return 13000;
  } else if ((busNo.length === 4 && busNo[0] === "9") || busNo[0] === "M") {
    // 광역
    // M버스도 여기 포함
    return 2300;
  } else if (busNo.length === 4) {
    // 지선
    return 1200;
  } else if (busNo.length === 3) {
    if (busNo[0] === "N") return 2150; // 심야
    return 1200; // 간선
  } else if (busNo.length === 2) {
    // 순환
    return 1100;
  }

  return 1200;
};

const getAdditionalBusCost = (dist) => {
  if (dist <= 10 * 1000) return 0;
  return Math.floor(((dist - 10 * 1000) / (5 * 1000)) * 100); // 5km마다 100원 추가
};

// *** 택시 비용 <-> 거리 관련 함수들
const getDistFromTaxiCost = ({ cost, arrTime }) => {
  const extraPercentage = calcExtraTaxiCostPercentage(arrTime);

  if (cost <= 4800 * extraPercentage) {
    return 1600;
  }

  return Math.floor(((cost / extraPercentage - 4800) / 100) * 131 - 1600);
};

const getTaxiCostFromDist = ({ dist, arrTime }) => {
  const extraPercentage = calcExtraTaxiCostPercentage(arrTime);

  if (dist <= 1600) {
    return 4800 * extraPercentage;
  }

  return Math.floor((4800 + ((dist - 1600) / 131) * 100) * extraPercentage);
};

const calcExtraTaxiCostPercentage = (arrTime) => {
  // 할증 계산
  if (
    (arrTime >= 22 * 60 && arrTime < 23 * 60) ||
    (arrTime >= 26 * 60 && arrTime < 28 * 60)
  )
    return 1.2;
  else if (arrTime >= 23 * 60 && arrTime < 26 * 60) return 1.4;

  return 1;
};

module.exports = {
  findTaxiPath,
};
