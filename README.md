# Server
## API reference

### 대중교통 최종 막차 시간 및 경로 탐색
#### HTTP method

`get`

#### url

`http://52.78.214.66:3000/route/getLastTimeAndPath`

#### parameters

1. query params

   | name               | type   | required | default   | explanation                                            |
   | ------------------ | ------ | -------- | --------- | ------------------------------------------------------ |
   | startX             | float  | O        |           | 출발지의 X좌표 (경도)                                  |
   | startY             | float  | O        |           | 출발지의 Y좌표 (위도)                                  |
   | endX               | float  | O        |           | 도착지의 X좌표 (경도)                                  |
   | endY               | float  | O        |           | 도착지의 Y좌표 (위도)                                  |
   | time               | string | O        |   | 현재 시간 <br>(2023-05-22T20:40:00) |

### response (type: `json`)

```
{
    pathExistance: boolean,
    departureTime: 출발 시간,
    arrivalTime: 도착 시간,
    pathInfo: {
        pathType: 대중교통의 혼합 종류,
        info: {
            "trafficDistance": 총 대중교통 거리,
            "totalWalk": 총 걷는 거리,
            "totalTime": 소요 시간,
            "payment": 요금,
            "busTransitCount": 버스 환승 횟수,
            "subwayTransitCount": 지하철 환승 횟수,
            "firstStartStation": 처음 출발역,
            "lastEndStation": 마지막 도착역,
            "totalStationCount": 총 역 개수,
            "busStationCount": 버스 역 개수,
            "subwayStationCount": 지하철 역 개수,
            "totalDistance": 총 거리,
            "totalWalkTime": 총 소요시간,
            "checkIntervalTime": 배차 간격 체크 기준,
            "checkIntervalTimeOverYn": 배차 간견 체크 초과하는 노선 있는 확인 여부
        },
        subPath: [
            {
                trafficType: 이동 수단 종류 (1-지하철, 2-버스, 3-도보, 4-환승 도보, 5-택시),
                distance: 구간 소요 거리,
                sectionTime: 이동 소요 시간,
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
                        departureTime: 도보/택시 출발 시간,
                        arrivalTime: 도보/택시 도착 시간,
                    }
                ],
                busTerm: 버스 배차 간격,
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

### 택시를 포함한 대중교통 길찾기

####  HTTP method

`get`

####  url

`http://52.78.214.66:3000/taxiRoute/findTaxiPath`

####  parameters

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

#### response (type: `json`)

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

## 브랜치 관리 규칙

- `master` : 정식 배포용
- `develop` : 다음 버전 개발용
    - `master`에서 분기, 작업 후 `master`로 병합
- `feature/기능명` : 특정 기능 개발용
    - `develop`에서 분기, 작업 후 `develop`으로 병합
- `hotfix` : `master` 브랜치의 오류 수정용
    - `master`에서 분기, 작업 후 `master`로 병합

## 커밋 메세지 규칙
제목 작성 시, 커밋 유형에 맞는 `[Type]`을 앞에 붙여주세요. 

- `[FEAT ADD/UPDATE/REMOVE]` 기능 추가/수정/삭제
- `[FIX]` 버그 수정
- `[DOCS]` 문서 수정
- `[STYLE]` 코드 포맷팅
- `[REFACTOR]` 코드 리팩토링
- `[TEST]` 테스트 코드
- `[BUILD]` 빌드 파일 수정
- `[CHORE]` 기타 파일 수정
