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
       trainStationId: Set(inout-trainNum1, ...)
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
       privStationId,
       privRouteId
       }
   } ]
   ```
