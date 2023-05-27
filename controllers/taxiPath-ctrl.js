const mysql = require("../mysql/mysql");
const axios = require("axios");
const qs = require("qs");
const geohash = require("ngeohash");
const haversine = require("haversine");

const level = 6; // geohash level

// 10분 = 대각선 약 700m, 가로 세로는 500m
// 1분에 약 50m 이동 가능하다고 가정
const walkingUnit = 50;
// 1분에 약 400m 이동 가능하다고 가정
const taxiUnit = 400;

// *** 기본 상수
const defaultMaxTransfer = 4;
const defaultMaxCost = 30000;
const defaultMaxWalking = 40;
const defaultMaxWalkingPerEachStep = 20;
const walkingRouteId = "walking";
const taxiRouteId = "taxi";
const train = 1,
  bus = 2,
  walking = 3,
  transferWalking = 4,
  taxi = 5;
const subwayCodeDict = {
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

const findTaxiPath = async (req, res) => {
  try {
    let {
      SX: startLng,
      SY: startLat,
      EX: endLng,
      EY: endLat,
      startDate = new Date("2023-05-29T02:00:00"),
      maxTransfer = defaultMaxTransfer,
      maxCost = defaultMaxCost,
      maxWalking = defaultMaxWalking,
    } = req.query;

    // 1. 길찾기에 쓰이는 데이터 구축
    const {
      startTime,
      stationsByGeohash,
      stationInfos,
      routesByStation,
      tripsByRoute,
      busRouteInfos,
    } = await init({ startDate });

    // 2. raptor 알고리즘에 필요한 시작/끝역 초기 데이터 구축
    const { markedStations, initReachedInfo } = getInitInfos({
      startGeohash: geohash.encode(startLat, startLng),
      startTime,
      stationsByGeohash,
    });
    const endMarkedStations = getFinalInfo({
      endGeohash: geohash.encode(endLat, endLng),
      stationsByGeohash,
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
      maxCost,
      maxWalking,
    });

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
      // ** 경로 세부정보 추가를 위한 데이터
      stationInfos,
      routesByStation,
      tripsByRoute,
      busRouteInfos,
    });

    // 도보만으로는 이동 불가 case -> 끝부분 택시 이동
    if (paths.length === 0) {
      console.log("마지막역 -> 도착지 택시 필요");

      const endTaxiMarkedStations = getFinalInfo({
        endGeohash: geohash.encode(endLat, endLng),
        stationsByGeohash,
        radius: getDistFromTaxiCost({ cost: maxCost, arrTime: 24 * 60 }), // TODO: arrTime 세밀하게 조정
      });

      // 기존 길찾기 결과에서, 마지막 경로가 taxi 이동 허용하는 것 선택
      paths = mkPaths({
        // *** 경로 만들 데이터
        startTime,
        reachedInfos,
        transferNum,
        endMarkedStations: endTaxiMarkedStations,
        startLng,
        startLat,
        endLng,
        endLat,
        // ** 경로 세부정보 추가를 위한 데이터
        stationInfos,
        routesByStation,
        tripsByRoute,
        busRouteInfos,
      });
    }

    // 끝부분 택시 이동 불가 case -> 앞부분 택시 이동
    if (paths.length === 0) {
      console.log("출발지 -> 첫역 택시 필요");

      const {
        markedStations: taxiMarkedStations,
        initReachedInfo: taxiInitReachedInfo,
      } = getInitInfos({
        startGeohash: geohash.encode(startLat, startLng),
        startTime,
        stationsByGeohash,
        radius: getDistFromTaxiCost({ cost: maxCost, arrTime: 24 * 60 }), // TODO: arrTime 세밀하게 조정
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
        maxCost,
        maxWalking,
      }));

      console.log(reachedInfos, transferNum);

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
        // ** 경로 세부정보 추가를 위한 데이터
        stationInfos,
        routesByStation,
        tripsByRoute,
        busRouteInfos,
      });
    }

    if (paths.length === 0) {
      // 어떠한 경로도 없는 경우
      res.send({
        pathExistence: false,
      });
      return;
    }

    // 5. paths들 추려내기
    const selectedPaths = selectAndSortPaths({
      paths,
      // *** alg setting
      maxCost,
      maxWalking,
    });

    // // 6. 추려낸 path에 대해 도보, 택시 정보 추가 및 값 보정
    // const resultPaths = await addRealtimeInfos({
    //   startDate,
    //   paths: [selectedPaths[0]],
    // });

    res.send({
      pathExistence: true,
      pathInfo: selectedPaths[0],
    });
  } catch (err) {
    console.log(err);
    return res.status(400).send({ err: err.message });
  }
};

// *** 길찾기 alg에 필요한 모든 input data 설정
const init = async ({ startDate }) => {
  // 1. 오늘 정보 가져오기
  if (getTimeFromDate(startDate) < 7 * 60) {
    startDate.setDate(startDate.getDate() - 1); // 전날 시간표로 취급해야 함
  }

  // 출발지에서 출발할 첫 시간
  const startTime = getTimeFromDate(startDate);

  // week 생성
  const busWeek = getBusWeekFromWeek(startDate),
    trainWeek = getTrainWeekFromWeek(startDate);

  // 2. DB에서 정보 가져오기
  const [
    { stationsByGeohash, stationInfos },
    { routesByStation, tripsByRoute, busRouteInfos },
  ] = await Promise.all([
    getEnableStationsFromDB(),
    getEnableRoutesFromDB({ busWeek, trainWeek }),
  ]);

  return {
    startTime,
    stationsByGeohash,
    stationInfos,
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
  maxCost,
  maxWalking,
}) => {
  console.log("raptor 알고리즘 시작");

  // ** 길찾기 도중에 또는 output으로 사용될 data
  const reachedInfos = []; // 각 round별 도착시간, 소요도보시간, 소요택시비 저장
  const fastestReachedIndsByStation = {}; // 가장 빠른 도착시간 저장

  reachedInfos.push(initReachedInfo);
  reachedInfos.push({});

  // 2. round 반복
  let transferNum;
  for (transferNum = 1; transferNum <= maxTransfer; transferNum++) {
    // maxTransfer 만큼의 round 반복
    markedRoutes = {};

    // 2-a. 같은 노선에 대해 더 이른 역에서 탑승할 수 있는 경우, 그 역에서 타면 됨
    // TODO: 급행 고려 필요 <- 급행 시간 잘 파악해보고, 늦은 시간에도 급행 다닌다면 고려해야 함
    for (const station of markedStations) {
      // TODO: 왜 routesByStation[station]에서 undefined 나오는지? stationId == 118000006
      // console.log(station, routesByStation[station]);
      if (routesByStation[station] === undefined) continue;

      for (const route of routesByStation[station]) {
        let trip = getNowTrip({
          route,
          trip: tripsByRoute[route],
          station,
          term: route in busRouteInfos ? busRouteInfos[route].term : -1,
          arrTime: reachedInfos[transferNum - 1][station].arrTime,
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

      arrTime =
        reachedInfos[transferNum - 1][markedRoutes[route].startStationId]
          .arrTime;
      let trip = getNowTrip({
        route,
        trip: tripsByRoute[route],
        station: startStation,
        term: route in busRouteInfos ? busRouteInfos[route].term : -1,
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
          transferNum != fastestReachedIndsByStation[trip[i].stationId] &&
          trip[i].stationId in reachedInfos[transferNum] &&
          minArrTime < reachedInfos[transferNum][trip[i].stationId].arrTime
        ) {
          minArrTime = reachedInfos[transferNum][trip[i].stationId].arrTime;
        }

        if (trip[i].arrTime < minArrTime) {
          reachedInfos[transferNum][trip[i].stationId] = {
            arrTime: trip[i].arrTime,
            walkingTime:
              reachedInfos[transferNum - 1][startStation].walkingTime,
            index: i,
            prevStationId: startStation,
            prevRouteId: route,
            prevIndex: startStationInd,
          };
          fastestReachedIndsByStation[trip[i].stationId] = transferNum;

          markedStations.add(trip[i].stationId);
        }

        // 더 빠른 시간에 열차 탑승이 가능한 경우, 이전 trip을 사용해도 됨
        if (
          transferNum > 0 &&
          reachedInfos[transferNum - 1].arrTime <= trip[i].arrTime
        ) {
          trip = getNowTrip({
            route,
            trip: tripsByRoute[route],
            station: trip[i].stationId,
            term: route in busRouteInfos ? busRouteInfos[route].term : -1,
            arrTime: reachedInfos[transferNum - 1].arrTime,
          });
        }
      }
    }

    // 도보 이동
    // 그냥 한/인접한 geohash에서 남은 도보 시간만큼 인접 geohash까지 이동 가능
    let footReachedInfo;
    ({ markedStations, footReachedInfo } = getNextInfos({
      markedStations,
      reachedInfo: reachedInfos[transferNum],
      stationsByGeohash,
      stationInfos,
    }));
    reachedInfos[transferNum] = footReachedInfo;

    // 표시된 역 없는 경우 종료
    if (markedStations.size === 0 || transferNum === maxTransfer) {
      break;
    } else {
      reachedInfos.push({});
    }
  }

  return { reachedInfos, transferNum };
};

// *** raptor 결과 -> 경로
const mkPaths = ({
  // *** 경로 만들 데이터
  startTime,
  reachedInfos,
  transferNum,
  endMarkedStations,
  startLat,
  startLng,
  endLat,
  endLng,
  // ** 경로 세부정보 추가를 위한 데이터
  stationInfos,
  routesByStation,
  tripsByRoute,
  busRouteInfos,
  // *** alg setting
  maxCost,
  maxWalking,
}) => {
  const paths = [];

  // 환승이 적은 것부터,
  for (let i = 0; i < transferNum; i++) {
    // 도착역에서부터 거슬러 올라가며, 각 역에서의 정보 확인
    for (const endStation of endMarkedStations) {
      if (!(endStation in reachedInfos[i])) continue;

      // j번 환승을 통해 station에 도달한 경우
      const nowPath = {
        info: {
          totalTime: reachedInfos[i][endStation].arrTime - startTime, // TODO: 마지막 도보 더하기
          // payment, // TODO
          transferCount: i,
          // firstStartStation -> 맨 마지막에
          lastEndStation: stationInfos[endStation].stationName,
          totalWalkTime: reachedInfos[i][endStation].walkingTime,
        },
        subPath: [],
      };

      let lastReachedInfo = reachedInfos[i][endStation],
        nowReachedInfo = lastReachedInfo,
        prevReachedInfo;
      let station = endStation;
      for (let j = i; j > 0; j--) {
        if (nowReachedInfo.prevRouteId === walkingRouteId) {
          if (nowReachedInfo.prevStationId === null) {
            // -> 출발지
            break;
          }

          prevReachedInfo = reachedInfos[j][nowReachedInfo.prevStationId];

          // 도보 이동
          nowPath.subPath.unshift({
            trafficType: transferWalking,
            sectionTime:
              nowReachedInfo.walkingTime - prevReachedInfo.walkingTime,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            endX: stationInfos[station].lng,
            endY: stationInfos[station].lat,
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            endName: stationInfos[station].stationName,
            departureTime: nowReachedInfo.arrTime,
          });

          station = nowReachedInfo.prevStationId;
          nowReachedInfo = prevReachedInfo;
        } else if (nowReachedInfo.prevRouteId === taxiRouteId) {
          prevReachedInfo = reachedInfos[j][nowReachedInfo.prevStationId];

          // TODO: taxi 경우도 추가 필요

          station = nowReachedInfo.prevStationId;
          nowReachedInfo = prevReachedInfo;
        }

        prevReachedInfo = reachedInfos[j - 1][nowReachedInfo.prevStationId];

        // 한 대중교통 이동의 세부 경로 계산
        const trip = getNowTrip({
          trip: tripsByRoute[nowReachedInfo.prevRouteId],
          station,
          term:
            nowReachedInfo.prevRouteId in busRouteInfos
              ? busRouteInfos[nowReachedInfo.prevRouteId].term
              : -1,
          arrTime: prevReachedInfo.arrTime,
        });
        const passStopList = { stations: [] };

        let cnt = 0;
        let prevId = null;
        for (let i = nowReachedInfo.prevIndex; i <= nowReachedInfo.index; i++) {
          if (prevId === trip[i].stationId) continue;

          passStopList.stations.push({
            index: cnt,
            stationName: stationInfos[trip[i].stationId].stationName,
            x: stationInfos[trip[i].stationId].lng,
            y: stationInfos[trip[i].stationId].lat,
            departureTime: trip[i].arrTime,
          });

          if (checkIsBusStation(trip[i].stationId)) {
            passStopList.stations[cnt].localStationID = trip[i].stationId;
          } else {
            passStopList.stations[cnt].stationID = trip[i].stationId;
          }

          prevId = trip[i].stationId;
          cnt++;
        }

        // 대중교통별 정보 추가
        if (checkIsBusStation(station)) {
          // 버스
          nowPath.subPath.unshift({
            trafficType: bus,
            sectionTime: nowReachedInfo.arrTime - prevReachedInfo.arrTime,
            stationCount: cnt - 1,
            lane: [
              {
                busNo: busRouteInfos[nowReachedInfo.prevRouteId].routeName,
                busLocalBlID: nowReachedInfo.prevRouteId,
                departureTime: nowReachedInfo.arrTime,
              },
            ],
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            startLocalStationID: nowReachedInfo.prevStationId,
            endName: stationInfos[station].stationName,
            endX: stationInfos[station].lng,
            endY: stationInfos[station].lat,
            endLocalStationID: station,
            passStopList,
          });
        } else {
          // 지하철
          nowPath.subPath.unshift({
            trafficType: train,
            stationCount: cnt - 1,
            sectionTime: nowReachedInfo.arrTIme - prevReachedInfo.arrTime,
            lane: [
              {
                name: nowReachedInfo.prevRouteId.slice(0, -2), // (-1, -2 제거)
                subwayCode:
                  subwayCodeDict[nowReachedInfo.prevRouteId.slice(0, -2)],
                departureTime: nowReachedInfo.arrTIme,
              },
            ],
            startName: stationInfos[nowReachedInfo.prevStationId].stationName,
            startX: stationInfos[nowReachedInfo.prevStationId].lng,
            startY: stationInfos[nowReachedInfo.prevStationId].lat,
            endName: stationInfos[station].stationName,
            endX: stationInfos[station].lng,
            endY: stationInfos[station].lat,
            // way: // TODO: 방면 정보 추가
            wayCode: parseInt(nowReachedInfo.prevRouteId.slice(-2, 0)),
            passStopList,
          });
        }

        station = nowReachedInfo.prevStationId;
        nowReachedInfo = prevReachedInfo;
      }

      // 첫역 -> 출발지 정보 추가
      nowPath.subPath.unshift({
        startX: startLng,
        startY: startLat,
        endX: stationInfos[station].lng,
        endY: stationInfos[station].lat,
        startName: "출발지",
        endName: stationInfos[station].stationName,
      });
      if (nowReachedInfo.prevRouteId === walkingRouteId) {
        nowPath.subPath[0] = {
          ...nowPath.subPath[0],
          trafficType: walking,
          sectionTime: nowReachedInfo.walkingTime,
        };
      } else {
        // taxiRouteId
        nowPath.subPath[0] = {
          ...nowPath.subPath[0],
          trafficType: taxi,
          sectionTime: nowReachedInfo.taxiTime,
          payment: getTaxiCostFromDist({
            dist: haversine(
              {
                latitude: nowPath.subPath[0].startY,
                longitude: nowPath.subPath[0].startX,
              },
              {
                latitude: nowPath.subPath[0].endY,
                longitude: nowPath.subPath[0].endX,
              },
              { unit: "meter" }
            ),
          }),
        };
      }

      // 도착지 -> 마지막역 정보 추가
      nowPath.subPath.push({
        trafficType: walking,
        sectionTime: nowReachedInfo.walkingTime - prevReachedInfo.walkingTime,
        startX: stationInfos[endStation].lng,
        startY: stationInfos[endStation].lat,
        endX: endLng,
        endY: endLat,
        startName: stationInfos[endStation].stationName,
        endName: "도착지", // TODO: 도착 위치 이름 변경
      });
      if (lastReachedInfo.prevRouteId === walkingRouteId) {
        nowPath.subPath[i] = {
          ...nowPath.subPath[i],
          trafficType: walking,
          sectionTime: getTimeFromDist({
            dist: haversine(
              {
                latitude: nowPath.subPath[i].startY,
                longitude: nowPath.subPath[i].startX,
              },
              {
                latitude: nowPath.subPath[i].endY,
                longitude: nowPath.subPath[i].endX,
              },
              { unit: "meter" }
            ),
          }),
        };
      } else {
        // taxiRouteId
        nowPath.subPath[i] = {
          ...nowPath.subPath[i],
          trafficType: taxi,
          sectionTime: getTimeFromDist({
            dist: haversine(
              {
                latitude: nowPath.subPath[0].startY,
                longitude: nowPath.subPath[0].startX,
              },
              {
                latitude: nowPath.subPath[0].endY,
                longitude: nowPath.subPath[0].endX,
              },
              { unit: "meter" }
            ),
            isWalking: false,
          }),
          payment: lastReachedInfo.taxiCost,
        };
      }

      // 도착지 -> 마지막역 정보 추가
      // 첫 역 정보를 알아야지만 계산 가능한 정보 추가
      nowPath.info.firstStartStation = stationInfos[station].stationName;

      // path 정보 추가
      paths.push(nowPath);
    }
  }

  return paths;
};

// TODO: 각 경로 비교 알고리즘 구현
const selectAndSortPaths = ({
  paths,
  // *** alg setting
  maxCost,
  maxWalking,
}) => {
  let newPaths = [];

  // TODO: 중복 노선 제거 (출발 -> 끝 역만 미세하게 다르고 동일 노선 타는 수많은 case들)
  // TODO: sort

  // 1. 지났던 역 또 지나는 경로 추려내기 -> 필요 X, 기존 알고리즘에서 이미 처리하는 부분
  // for (let i = 0; i < paths.length; i++) {
  //   let isOkay = true;
  //   const middleStationSet = new Set(),
  //     startStationSet = new Set(),
  //     endStationSet = new Set();
  //   const prevRouteType = null,
  //     prevRouteId = null;

  //   for (const subPath of paths[i].subPath) {
  //     if (!(subPath.trafficType === bus || subPath.trafficType === train))
  //       continue;
  //     if (prevRouteType === subPath.trafficType) {
  //     }

  //     // 대중교통 탈 때, 중간역들을 이전에 지난 적 있으면 안 됨 (반복하여 동일 역 지나가는 비효율적인 경로)
  //     // or, 전 단계에서 이미 endStation에 포함된 역 있다면 drop
  //     for (let j = 0; j < subPath.passStopList.stations.length; j++) {
  //       const station =
  //         subPath.trafficType === bus
  //           ? subPath.passStopList.stations[j].localStationID
  //           : subPath.passStopList.stations[j].stationID;
  //       if (
  //         station in middleStationSet ||
  //         // 출발-도착역 pair의 경우 문제 X
  //         (j == 0 && station in startStationSet) ||
  //         (j == subPath.passStopList.stations.length - 1 &&
  //           station in endStationSet) ||
  //         (!(j == 0 || j == subPath.passStopList.stations.length - 1) &&
  //           (station in startStationSet || station in endStationSet))
  //       ) {
  //         console.log(
  //           middleStationSet,
  //           startStationSet,
  //           endStationSet,
  //           subPath.passStopList.stations[j].stationName
  //         );
  //         isOkay = false;
  //         break;
  //       }

  //       if (j == 0) startStationSet.add(station);
  //       else if (j == subPath.passStopList.stations.length - 1)
  //         endStationSet.add(station);
  //       else middleStationSet.add(station);
  //     }

  //     if (!isOkay) break;
  //   }

  //   if (isOkay) {
  //     newPaths.push(paths[i]);
  //   }
  // }

  // // 2. 동일 노선 또 타는 문제 해결
  // for (let i = 0; i < paths.length; i++) {
  //   let prevRouteType = null,
  //     prevRouteName = null;
  //   let isOkay = true;

  //   for (const subPath of paths[i].subPath) {
  //     if (!(subPath.trafficType === bus || subPath.trafficType === train))
  //       continue;

  //     if (
  //       prevRouteType === subPath.trafficType &&
  //       prevRouteName === (subPath.trafficType === bus)
  //         ? subPath.lane[0].busNo
  //         : subPath.lane[0].name
  //     ) {
  //       isOkay = false;
  //       break;
  //     }

  //     prevRouteType = subPath.trafficType;
  //     prevRouteName =
  //       subPath.trafficType === bus
  //         ? subPath.lane[0].busNo
  //         : subPath.lane[0].name;
  //   }

  //   if (isOkay) {
  //     newPaths.push(paths[i]);
  //   }
  // }

  return paths;
};

const addRealtimeInfos = async ({ startDate, paths }) => {
  let realtimePaths = null;
  try {
    realtimePaths = await Promise.all(
      paths.map((path) => {
        return addEachRealtimeInfo({ startDate, path });
      })
    );
  } catch (err) {
    throw err;
  }

  return realtimePaths;
};

const addEachRealtimeInfo = async ({ startDate, path }) => {
  const { SK_KEY, SK_WALKING_URL } = process.env;
  const newPath = { ...path, subPath: [] };

  for (const subPath of path.subPath) {
    if (
      subPath.trafficType === walking ||
      subPath.trafficType === transferWalking
    ) {
      // 도보
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

        newPath.subPath.push({
          ...subPath,
          // TODO: 소요시간 정보 보정
          steps: response.features.map((el) => {
            return { type: el.type, geometry: el.geometry };
          }),
          distance: response.features[0].properties.totalDistance,
          sectionTime: Math.round(
            response.features[0].properties.totalTime / 10
          ),
        });
      } catch (err) {
        throw err;
      }
    } else if (subPath.trafficType === taxi) {
      // 택시
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

        newPath.subPath.push({
          ...subPath,
          // TODO: 소요시간 정보 보정
          steps: response.features.map((el) => {
            return { type: el.type, geometry: el.geometry };
          }),
          distance: response.features[0].properties.totalDistance,
          sectionTime: Math.round(
            response.features[0].properties.totalTime / 10
          ),
          payment: response.features[0].properties.taxiFare, // TODO: * calcExtraTaxiCostPercentage(arrTime) 필요
        });
      } catch (err) {
        throw err;
      }
    } else {
      // 대중교통
      // TODO: 실시간 도착정보 추가

      newPath.subPath.push({
        ...subPath,
      });
    }
  }

  return newPath;
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
  let week = date.getDay();
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
  let time = now.getHours() * 60 + now.getMinutes();
  if (time < 7 * 60) {
    time += 24 * 60;
  }

  return time;
};

// *** DB에서 데이터 불러오는 함수들
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
      SELECT route_id, route_name, ${busWeek} as term
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
      busRouteInfos = {};

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

// *** tripsByRoute에 사용할, 지하철 노선 + inout으로 id 생성하는 함수
const getTrainRouteId = ({ routeName, inout }) => {
  return routeName + "-" + String(inout);
};

// *** 버스 정류장인지 지하철 정류장인지 확인하는 함수
const checkIsBusStation = (id) => {
  if (parseInt(id) >= 100000000) return true;

  return false;
};

// *** arrTIme에 맞는 trip 정보 가져오는 함수
const getNowTrip = ({ route, trip, station, term = 15, arrTime = -1 }) => {
  // TODO: 배차간격 없는 경우 일단 15분으로 처리해둠 -> radius walkingUnit 등 모든 상수 리팩토링 필요
  if (checkIsBusStation(station)) {
    // 버스
    // 배차간격 -1일 경우, 해당 요일에 운영 X
    if (term === -1) return null;

    // 첫 정류장에 대한 해당 노선 경로에서의 index
    const startStationInd = trip.findIndex((el) => el.stationId === station);

    // 정류장을 지나지 않는 경우 (오류 case)
    if (startStationInd === -1) return null;

    // 1. 막차 시간 - (정류장 도달 시간) 차 계산
    let diff;
    if (arrTime === -1) {
      diff = 0;
    } else {
      diff = trip[startStationInd].arrTime - (term + arrTime);
    }

    // 막차 시간을 이미 지났으면, 탑승 불가
    if (diff < 0) return null;

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

      if (
        trip[trainId][startStationInd].arrTime < minArrTime &&
        trip[trainId][startStationInd].arrTime > arrTime
      ) {
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

// *** 첫 위치에서 도보 이동 가능 역들 이동하는 함수
const getInitInfos = ({
  startGeohash,
  startTime,
  stationsByGeohash,
  radius = defaultMaxWalkingPerEachStep * walkingUnit,
  isWalking = true,
}) => {
  let markedStations = new Set();
  const initReachedInfo = {};

  const circleGeohash = getCircleGeohash({
    centerGeohash: startGeohash,
    radius,
    isWalking,
  });

  for (const hash in circleGeohash) {
    if (stationsByGeohash[hash] === undefined) {
      continue;
    }

    markedStations = new Set([...markedStations, ...stationsByGeohash[hash]]);

    for (const station of stationsByGeohash[hash]) {
      const arrTime = startTime + circleGeohash[hash];

      if (isWalking) {
        initReachedInfo[station] = {
          arrTime,
          walkingTime: circleGeohash[hash],
          prevStationId: null,
          prevRouteId: walkingRouteId,
        };
      } else {
        initReachedInfo[station] = {
          arrTime,
          walkingTime: 0,
          taxiTime: circleGeohash[hash],
          prevStationId: null,
          prevRouteId: walkingRouteId,
        };
      }
    }
  }

  // taxi로 빼게 될 경우
  // TODO: defaultMaxWalking이 아닌, 실제 함수에서 입력받은 값으로 설정되도록 수정
  if (radius > defaultMaxWalkingPerEachStep * walkingUnit) {
    const beforeCheckedStations = getInitInfos({
      startGeohash,
      stationsByGeohash,
    });

    markedStations = new Set(
      [...markedStations].filter((el) => !(el in beforeCheckedStations))
    );
  }

  return { markedStations, initReachedInfo };
};

const getFinalInfo = ({
  endGeohash,
  stationsByGeohash,
  radius = defaultMaxWalkingPerEachStep * walkingUnit,
}) => {
  let markedStations = new Set();

  const circleGeohash = getCircleGeohash({
    centerGeohash: endGeohash,
    radius,
  });

  for (const hash in circleGeohash) {
    if (stationsByGeohash[hash] === undefined) {
      continue;
    }

    markedStations = new Set([...markedStations, ...stationsByGeohash[hash]]);
  }

  // taxi로 빼게 될 경우
  // TODO: defaultMaxWalking이 아닌, 실제 함수에서 입력받은 값으로 설정되도록 수정
  if (radius > defaultMaxWalkingPerEachStep * walkingUnit) {
    const beforeCheckedStations = getFinalInfo({
      endGeohash,
      stationsByGeohash,
    });

    markedStations = new Set(
      [...markedStations].filter((el) => !(el in beforeCheckedStations))
    );
  }

  return markedStations;
};

// *** 도보 이동 가능 역들 이동하는 함수
const getNextInfos = ({
  markedStations,
  reachedInfo,
  stationsByGeohash,
  stationInfos,
  radius = defaultMaxWalkingPerEachStep * walkingUnit,
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
      radius,
    });

    // hash 안에 있는 역들마다, 새 key 저장
    for (const curHash in geohashes) {
      const curHashInfo = markedGeohashes[curHash];

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
            prevStationId: markedGeohashes[curHash].stationId,
            prevRouteId: walkingRouteId,
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

// *** Geohash 관련 함수들
// centerGeohash를 중심으로 radius를 반지름으로 하는 원을 geohash들로 만들어 리턴
const getCircleGeohash = ({ centerGeohash, radius, isWalking = true }) => {
  const centerPoint = geohash.decode(centerGeohash);

  const geohashes = {};
  // ** geohashes
  // { geohash: walkingTime or taxiTime }

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
        geohashes[neighbors[i]] = getTimeFromDist({ dist: radius, isWalking });
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

// *** 거리 <-> 시간 관련 함수
const getTimeFromDist = ({ dist, isWalking = True }) => {
  let time;
  if (isWalking) {
    time = Math.round(dist / walkingUnit);
  } else {
    time = Math.round(dist / taxiUnit);
  }

  return time;
};

// *** 택시 비용 <-> 거리 관련 함수들
const getDistFromTaxiCost = ({ cost, arrTime }) => {
  const extraPercentage = calcExtraTaxiCostPercentage(arrTime);

  if (cost <= 4800 * extraPercentage) {
    return 1600;
  }

  return ((cost / extraPercentage - 4800) / 100) * 131 - 1600;
};

const getTaxiCostFromDist = ({ distance, arrTime }) => {
  const extraPercentage = calcExtraTaxiCostPercentage(arrTime);

  if (distance <= 1600) {
    return 4800 * extraPercentage;
  }

  return (4800 + ((distance - 1600) / 131) * 100) * extraPercentage;
};

const calcExtraTaxiCostPercentage = (arrTime) => {
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
