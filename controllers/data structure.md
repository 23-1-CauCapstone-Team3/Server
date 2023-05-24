### 길찾기에 필요한 input data

1. stationsByGeohash

   ```
   {
       geoHash: Set(stationId1, 2, ... )
   }
   ```

2. routesByStation

   ```
   {
       stationId: Set(routeId1, 2, ...)
   }
   ```

3. tripsByRoute
   ```
   {
       busRouteId: [ {
           stationId,
           arrTime
       } ],
       trainRouteId: [ {
           stationId,
           arrTime
       } ]
   }
   ```
4. termByRoute
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
