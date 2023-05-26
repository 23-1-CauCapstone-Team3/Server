### 길찾기에 필요한 input data

1. stationsByGeohash

   ```
   {
       geoHash: Set(stationId1, 2, ... )
   }
   ```

2. stationInfos

   ```
   {
       stationId: {
            stationName,
            lat
            lng
       }
   }

   ```

3. routesByStation

   ```
   {
       busStationId: Set(routeId1, 2, ...),
       trainStationId: Set(route-inout, ...)
   }
   ```

4. tripsByRoute
   ```
   {
       busRouteId: [ {
            order,
            stationId,
            arrTime
       } ],
        routeName-inout: {
            trainId: [ {
                order,
                stationId,
                arrTime
            } ]
        }
   }
   ```
5. termByRoute
   ```
    {
       routeId: term
    }
   ```

### 길찾기 도중에 사용될 data

1. fastestReachedInfos

   ```
       [ {
           staionId: indexOfReachedInfosArray
       } ]
   ```

2. markedRoutes

   ```
   {
       routeId: {
           startStationId,
           startStationInd,
           arrTime
       }
   }
   ```

3. markedGeohashes
   ```
   {
       geohash: {
           arrTime,
           stationId,
           walkingTime
       }
   }
   ```

### output data

1. reachedInfos

   ```
   [ {
       staionId: {
       arrTime,
       walkingTime,
       taxiCost,
       index,
       prevStationId,
       prevRouteId,
       prevIndex,
       }
   } ]
   ```

2. paths

   ```
    {
        info: {
            totalWalkingTime: 총 도보 이동 시간, (** 다름)
            totalTime: 총 소요시간,
            payment: 총 요금,
            transferCount: 환승 카운트, (** 다름)
            firstStartStation: 첫 출발역,
            lastEndStation: 최종 도착역,
            totalStationCount: 총 정류장 합,
            busStationCount: 버스 정류장 합,
            subwayStationCount: 지하철 정류장 합,
        },
        subPath: [
            {
                trafficType: 이동 수단 종류 (1-지하철, 2-버스, 3-도보, 4-택시),
                sectionTime: 이동 소요 시간,
                stationCount: 이동하여 정차하는 정거장 수,
                lane: [
                    {
                        name: 지하철 노선명,
                        busNo: 버스 번호,
                    }
                ],
                startName: 승차 정류장명,
                startX,
                startY,
                endName: 하차 정류장명,
                endX,
                endY,
                way: 지하철 방면 정보,
                wayCode: 지하철 방면 정보 코드 (1-상행, 2-하행),
                startExitNo: 지하철 들어가는 출구 번호,
                startExitX,
                startExitY,
                endExitNo: 지하철 나가는 출구 번호,
                endExitX,
                endExitY,
                passStopList: {
                    stations: [
                        {
                            index: 순서,
                            stationName: 정류장 이름,
                            arrTime: 도착 시간, (** 다름)
                            x,
                            y,
                        }
                    ]
                },
                steps: [
                    type: 종류 문자열,
                    coordinates: [
                        [lat, lng]
                    ]
                ]
            }
        ]
    }
   ```
