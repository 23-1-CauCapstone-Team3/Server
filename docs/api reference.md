# API reference - 택시 포함 대중교통 경로안내

### HTTP method

`get`

### endpoint

`/findTaxiPath`

### parameters

1. query params

   | name               | type   | required | default   | explanation                                            |
   | ------------------ | ------ | -------- | --------- | ------------------------------------------------------ |
   | startX             | float  | O        |           | 출발지의 X좌표 (경도)                                  |
   | startY             | float  | O        |           | 출발지의 Y좌표 (위도)                                  |
   | endX               | float  | O        |           | 도착지의 X좌표 (경도)                                  |
   | endY               | float  | O        |           | 도착지의 Y좌표 (위도)                                  |
   | time               | string | X        | 현재 시간 | 출발지에서부터 출발하는 시간 <br>(2023-05-22T20:40:00) |
   | walkSpeed          | int    | X        | 50        | 도보 이동 속도 (m/분)                                  |
   | taxiSpeed          | int    | X        | 400       | 택시 이동 속도 (m/분)                                  |
   | maxTransfer        | int    | X        | 4         | 최대 환승 가능 횟수                                    |
   | maxCost            | int    | X        | 30000     | 최대 비용                                              |
   | maxTotalWalkTime   | int    | X        | 40        | 최대 총 도보 이동 시간                                 |
   | maxWalkTimePerStep | int    | X        | 20        | 한 번의 도보 이동에 대한 최대 도보 이동 시간           |

### response (type: json)

```
{
    pathExistance: boolean,
    departureTime: 출발 시간,
    arrivalTime: 도착 시간,
    pathInfo: {
        info: {
            departureTime: 출발 시간,
            arrivalTime: 도착 시간,
            transferCount: 환승 횟수,
            firstStartStation: 첫 출발역,
            lastEndStation: 최종 도착역,
            totalTime: 총 소요시간,
            totalWalkTime: 총 도보 이동 시간,
            totalTaxiTime: 총 택시 이동 시간,
            payment: 총 요금,
            taxiPayment: 택시 요금,
            transportPayment: 대중교통 총 요금,
        },
        subPath: [
            {
                trafficType: 이동 수단 종류 (1-지하철, 2-버스, 3-도보, 4-환승 도보, 5-택시),
                sectionTime: 이동 소요 시간,
                taxiPayment: 택시 비용,
                departureTime: 도보/택시 출발 시간,
                arrivalTime: 도보/택시 도착 시간,
                stationCount: 버스/지하철 이동하여 정차하는 정거장 수,
                lane: [
                    {
                        busNo: 버스명,
                        type: 버스 타입 코드,
                        busLocalBlID: 버스 노선 코드,
                        name: 지하철 노선명,
                        subwayCode: 지하철 노선 코드,
                        departureTime: 버스/지하철 출발 시간,
                        arrivalTime: 버스/지하철 도착시간
                    }
                ],
                startName: 승차 정류장명,
                startX,
                startY,
                startLocalStationID: 승차 정류장 버스역 코드,
                startStationID: 승차 정류장 지하철 역코드,
                endName: 하차 정류장명,
                endX,
                endY,
                endLocalStationID: 하차 정류장 버스역 코드,
                endStationID: 하차 정류장 지하철 역코드,
                way: 지하철 방면 정보,
                wayCode: 지하철 방면 정보 코드 (1-상행, 2-하행),
                passStopList: {
                    stations: [
                        {
                            index: 순서,
                            stationName: 정류장 이름,
                            arrivalTime: 도착 시간,
                            x,
                            y,
                            localStationID: 버스 정류장 코드,
                            stationID: 지하철 정류장 코드
                        }
                    ]
                },
                steps: [
                    {
                        type: 종류 문자열,
                        geometry: [
                            type: 종류 문자열,
                            coordinates: [lat, lng]
                        ]
                    }
                ]
            }
        ]
    }
}
```
