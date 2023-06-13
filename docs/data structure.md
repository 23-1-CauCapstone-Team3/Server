# Data structure

> Raptor 알고리즘 내부에서 쓰이는 data structure 정리

### Raptor alg input data

1. stationsByGeohash

   ```
   {
       geohash: Set(stationId1, 2, ... )
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

3. additionalTrainCostByStatIds

   ```
   {
       startStationId: {
           endStationId: cost
       }
   }
   ```

4. routesByStation

   ```
   {
       busStationId: Set(routeId1, 2, ...),
       trainStationId: Set(route-inout, ...)
   }
   ```

5. tripsByRoute

   ```
   {
       busRouteId: [
            {
                order,
                stationId,
                arrTime
            }
        ],
        routeName-inout-startStationId-endStationId-isDirect: {
            trainId: [
                {
                    order,
                    stationId,
                    arrTime
                }
            ]
        }
   }
   ```

6. busRouteInfos

   ```
    {
        routeId: {
            term,
            routeName
        }
    }
   ```

### Data structure used to perform raptor alg

1. fastestReachedInfos

   ```
    [
        {
            staionId: indexOfReachedInfosArray
        }
    ]
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

### Raptor alg output data

1. reachedInfos
   ```
    [
        {
            staionId: {
                arrTime,
                walkingTime,
                taxiTime,
                index,
                prevStationId,
                prevRouteId,
                prevIndex,
            }
        }
    ]
   ```
