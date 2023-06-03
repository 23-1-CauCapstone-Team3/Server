const { Router } = require('express')
const axios = require('axios')
const dayjs = require("dayjs")
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore")
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter')

dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)

require("dotenv").config();

const mysql = require('../mysql/mysql')  // mysql 모듈 로드

pathRouter = Router()

const SK_API_KEY = process.env.SK_API_KEY
const ODSAY_API_KEY = process.env.ODSAY_API_KEY

pathRouter.get('/getLastTimeAndPath', async(req, res) => {
  try{

    console.time('test')

    const time = req.query.time
    const startX = req.query.startX
    const startY = req.query.startY
    const endX = req.query.endX
    const endY = req.query.endY

    console.log(time)
    console.log(startX)
    console.log(startY)
    console.log(endX)
    console.log(endY)

      if(!time ||!startX || !startY || !endX || !endY){
        return res.status(400).send({ error: 'Request parameters are incorrect', result: false })
      }
    
    const userTime = dayjs(time);
    
    const [dayType, transport_base_date] = checkDateType(userTime)
    const dayCode = dayType === 'day'? 1 : dayType === 'sat' ? 2 : 3

    /**
     * 버스, 도보 여유 시간
     */
    const bus_alpha = 2
    const walk_alpha = 2


    const routeResult = await axios.get(`https://api.odsay.com/v1/api/searchPubTransPathT?SX=${startX}`+
                                        `&SY=${startY}&EX=${endX}&EY=${endY}&apiKey=${ODSAY_API_KEY}`);


    /**
     * 얻은 경로를 단순한 정보로 만들어주는 과정
     */
    const summarizedPaths = routeResult.data.result.path.map((element)=>{
      return element.subPath.map((subElement)=>{
        if(subElement.trafficType === 3){
          return subElement
        } else if(subElement.trafficType === 2){
          return {
            trafficType: subElement.trafficType,
            sectionTime : subElement.sectionTime, 
            lane : subElement.lane.map((e)=>{return e.busLocalBlID}), 
            startArsID: subElement.startArsID, 
            startLocalStationID: subElement.startLocalStationID}
        } else {
          return {
            trafficType: subElement.trafficType,
            sectionTime: subElement.sectionTime,
            lane : subElement.lane,
            wayCode: subElement.wayCode,
            startID: subElement.startID,
            endID: subElement.endID}
        }
      })
    })

    /**
     * 버스 노선 중복 제거 한 것 
     */
    const busList = summarizedPaths.flat()
      .filter(element => element.trafficType === 2)
      .map((element)=>{return element.lane.map((lanes)=>{ return {busLocalBlID: lanes, startLocalStationID: element.startLocalStationID} })})
      .flat()
      .reduce((accumulator, current) => {
        const res = accumulator.find(element => element.busLocalBlID === current.busLocalBlID && element.startLocalStationID === current.startLocalStationID)
        if (res) {
          return accumulator
        } else {
          return accumulator.concat([current])
        }
      }, [])
    
    /**
     * 기차 노선 중복 제거 한 것 
    */
    const trainList = summarizedPaths.flat()
      .filter(element => element.trafficType === 1)
      .map((element)=>{
        const {lane, ...rest} = element
        return element.lane.map((lanes)=>{ return {subwayCode: lanes.subwayCode, subwayName: lanes.name, ...rest} })})
      .flat()
      .reduce((accumulator, current) => {
        const res = accumulator.find(element => element.subwayCode === current.subwayCode && element.wayCode === current.wayCode 
                                    && element.startID === current.startID && element.endID === current.endID && element.subwayName === current.subwayName)
        if (res) {
          return accumulator
        } else {
          return accumulator.concat([current])
        }
      }, [])

    
    const bus_term_time = await getBusData(userTime, busList, dayType, transport_base_date)
    const train_time = await getRailTimes(userTime, trainList, dayCode, transport_base_date)


    /**
     * 경로들에 대해 막차 시간을 구하는 과정
     */
    
    const lastPaths = routeResult.data.result.path.map((element)=>{

      const path = element.subPath

      /**
       * 막차 시간 구하기 위해 초기에 설정한 값 클라이언트에서 준 날짜에 하루 뒤 날짜를 생성함.
       */

      let subLastPathTime = userTime.add(1, 'd')
      
      const subPathLength = path.length - 1

      /**
       * 각 서브 경로에 대해 막차 시간을 계산하는 구간
       * 역순으로 계산 실시
       * 3번 도보, 2번 버스, 1번 지하철
      */

      for(let i = subPathLength; i >= 0; i--){
        
        console.log('타입'+path[i].trafficType)

        if(subLastPathTime !== null){
          console.log('min 시간 : '+subLastPathTime.format())
        } else {
          console.log('null발생')
        }
        
        if(subLastPathTime !== null){

          if(path[i].trafficType === 3){

            console.log('텀: '+path[i].sectionTime)

            if(path[i].sectionTime == 0){
              path[i].sectionTime = 10
              subLastPathTime = subLastPathTime.subtract(10 + walk_alpha, 'm')
              console.log('텀: '+path[i].sectionTime)
            } else{
              subLastPathTime = subLastPathTime.subtract(path[i].sectionTime+walk_alpha, 'm')
            }
          } else if(path[i].trafficType === 2) {

            console.log('버스-'+path[i].sectionTime)

            const busLaneList = path[i].lane.map((element)=>{
              if(bus_term_time[element.busLocalBlID] !== undefined && bus_term_time[element.busLocalBlID] !== null){
                return bus_term_time[element.busLocalBlID]
              } else {
                return null
              }
            })

            if(busLaneList.filter(element => element).length > 0) {
              const bus_data = busLaneList.filter(element => element).reduce((prev, now) => {
                if(prev.lastTM.isSameOrAfter(now.lastTM)) {
                  return prev
                } else {
                  return now
                }
              })
              
              const busLastTime = bus_data.lastTM

              console.log(busLastTime.format())

              if(busLastTime.isSameOrBefore(subLastPathTime)) {
                console.log('버스: '+busLastTime.format(),path[i].sectionTime, bus_data.term)
                subLastPathTime = busLastTime.subtract(path[i].sectionTime,'m').subtract(bus_data.term,'m').subtract(bus_alpha,'m')
              } else {
                console.log('버스: '+busLastTime.format(),path[i].sectionTime, bus_data.term)
                subLastPathTime = subLastPathTime.subtract(path[i].sectionTime,'m').subtract(bus_data.term,'m').subtract(bus_alpha,'m')
              }
              path[i].busTerm = bus_data.term
              path[i].lane = path[i].lane.filter(element => element.busLocalBlID === String(bus_data.busRouteId))
              path[i].lane.departureTime = subLastPathTime.format()

            } else {
              subLastPathTime = null
            }
          } else {
            console.log('지하철'+path[i].sectionTime)
            
            let rail_type= 'FALSE'
            if(path[i].lane[0].name.includes('급행') || path[i].lane[0].name.includes('특급')){
              rail_type= 'TRUE'
            }
            
            const keyString = String(path[i].lane[0].subwayCode)+'-'+String(path[i].wayCode)+'-'+String(dayCode)+'-'
            +String(rail_type)+'-'+String(path[i].startID)+'-'+String(path[i].endID)

            console.log(keyString)

            if (train_time[keyString] !== undefined && train_time[keyString] !== null) {
              
              const endStationRail = train_time[keyString][path[i].endID].filter((element) => { 
                if(element['도착시간'].isBefore(subLastPathTime)) {
                  return true
                } else {
                  return false
                }
              })
              
              if(endStationRail.length > 0) {
                const endStationLastRail = endStationRail.reduce((prev, now) => { 
                  if(prev['도착시간'].isAfter(now['도착시간'])) {
                    return prev
                  } else {
                    return now
                  }
                })

                console.log('도착지'+endStationLastRail['도착시간'].format())

                const startStationLastRail = train_time[keyString][path[i].startID].filter((element)=> {
                  
                  if(element['열차번호'] === endStationLastRail['열차번호'] && element['도착시간'].isBefore(endStationLastRail['도착시간'])) {
                    return true
                  } else{
                    return false
                  }
                })
                

                if (startStationLastRail.length > 0){
                  startStationLastRail.map((e)=>{console.log(e['도착시간'].format())})
                  
                  const newLastPathTime = startStationLastRail.reduce((prev, now) => { 
                    if(prev['도착시간'].isAfter(now['도착시간'])) {
                      return prev
                    } else {
                      return now
                    }
                  })
                  
                  console.log('지하철 :'+newLastPathTime['도착시간'].format())
                  subLastPathTime = newLastPathTime['도착시간']
                  path[i].lane[0].departureTime = subLastPathTime.format()
                  path[i].lane[0].arrivalTime = endStationLastRail['도착시간'].format()
                
                } else {
                  subLastPathTime =  null
                }

              } else {
                subLastPathTime =  null
              }
              

            } else {
              subLastPathTime =  null
            }
          }
        }
        console.log('*******************************')
      }
      if(subLastPathTime != null)
        console.log('마지막 :'+subLastPathTime.format())
      else
        console.log('null')
      console.log('-----------------------------------')
      
      if(subLastPathTime === null){
        return null
      } else {
        return {
          'pathType':element.pathType,
          'info': element.info,
          'path': path,
          'subLastPathTime': subLastPathTime
        }
      }
    })
    .filter((element)=>{
      if(element === null){
        return false
      }
      if(element.subLastPathTime.isAfter(userTime)){
        return true
      } else {
        return false
      }
    })
    
    /**
     * 계산후 존재하는 경로만 확인후 만약 모두 경로가 없는 경우 경로가 없다는 데이터를 넘겨준다. 
     */
    const zeroNullPaths = lastPaths.filter((element)=>{
      if(element !== null){
        return true
      } else {
        false
      }
    })

    if(zeroNullPaths.length == 0){
      return res.status(200).send({
        pathExistence: false,
        arrivalTime: null, 
        departureTime:null, 
        pathInfo: null})
    }
    
    /**
     * 가장 늦은 시간을 골라낸다.
     */
    const lastPath = zeroNullPaths.reduce((prev, now) => {
        
      if(prev.subLastPathTime.isSameOrAfter(now.subLastPathTime)) {
        return prev
      } else {
        return now
      }
    })

    
    /**
     * 위에서 구한 마지막의 막차 경로에 대한 대략적인 도착 시간을 다시 연산하는 작업 
     */
    
    let arrivalTime = lastPath.subLastPathTime

    lastPath.path.map( (path) => {
      
      if(path.trafficType === 3){

        arrivalTime = arrivalTime.add(path.sectionTime, 'm').add(walk_alpha, 'm')

      } else if(path.trafficType === 2) {

        path.lane[0].departureTime = arrivalTime.format()
        const term = bus_term_time[path.lane[0].busLocalBlID].term
        arrivalTime = arrivalTime.add(path.sectionTime,'m').add(term,'m').add(bus_alpha, 'm')
          
      } else {

        // let rail_type= 'FALSE'
        //     if(path.lane[0].name.includes('급행') || path.lane[0].name.includes('특급')){
        //       rail_type= 'TRUE'
        //     }

        // const keyString = String(path.lane[0].subwayCode)+'-'+String(path.wayCode)+'-'+String(dayCode)+'-'
        //     +String(rail_type)+'-'+String(path.startID)+'-'+String(path.endID)

        // const endTimeInfo = train_time[keyString][path.endID].filter((element)=>{
        //   if(element['도착시간'].isAfter(arrivalTime) && element['도착시간'].isSameOrBefore(path.lane[0].arrivalTime)){
        //     return true
        //   } else {
        //     return false
        //   }
        // }).map((element)=>{

        // })
        
        arrivalTime = dayjs(path.lane[0].arrivalTime)
        
      }
    })

    /**
     * 도보경로에 대한 출발지점과 도착지점의 좌표값을 넣어주는 과정
     */
    for(let i=0 ; i < lastPath.path.length; i++){
      if(lastPath.path[i].trafficType === 3){
        if(i === 0){
          lastPath.path[i].startName = '출발지'
          lastPath.path[i].startX = parseFloat(startX)
          lastPath.path[i].startY = parseFloat(startY)
          lastPath.path[i].endName = lastPath.path[i+1].startName
          lastPath.path[i].endX = lastPath.path[i+1].startX
          lastPath.path[i].endY = lastPath.path[i+1].startY
        } else if(i === lastPath.path.length - 1){
          lastPath.path[i].startName = lastPath.path[i-1].endName
          lastPath.path[i].startX = lastPath.path[i-1].endX
          lastPath.path[i].startY = lastPath.path[i-1].endY
          lastPath.path[i].endName = '목적지'
          lastPath.path[i].endX = parseFloat(endX)
          lastPath.path[i].endY = parseFloat(endY)
        } else {
          lastPath.path[i].trafficType = 4
          lastPath.path[i].startName = lastPath.path[i-1].endName
          lastPath.path[i].startX = lastPath.path[i-1].endX
          lastPath.path[i].startY = lastPath.path[i-1].endY
          lastPath.path[i].endName = lastPath.path[i+1].startName
          lastPath.path[i].endX = lastPath.path[i+1].startX
          lastPath.path[i].endY = lastPath.path[i+1].startY
        }
      }
    }
    
    /** 
     * 도보경로의 좌표 정보와 sk 도보 api를 사용하여 자세한 도보 경로를 얻고 그 값을 추가해주는 과정
     * 최종 결과
    */
    const finalPathResult = await Promise.all(lastPath.path.map(async (element)=>{
      
      if(element.trafficType === 3 || element.trafficType === 4){

        const options = {
          method: 'POST',
          url: 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&callback=function',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            appKey: SK_API_KEY
          },
          data: {
            startX: element.startX,
            startY: element.startY,
            angle: 20,
            speed: 30,
            endX: element.endX,
            endY: element.endY,
            reqCoordType: 'WGS84GEO',
            startName: encodeURIComponent(element.startName),
            endName: encodeURIComponent(element.endName),
            searchOption: '0',
            resCoordType: 'WGS84GEO',
            sort: 'index'
          }
        }

        const walkRoute = await axios.request(options)
        
        element.step = walkRoute.data.features
        
      }
      return element
    }))

    console.timeEnd('test')
    console.log('******************************')
    
    
    return res.status(200).send({
      pathExistence: true,
      arrivalTime: arrivalTime.format('YYYY-MM-DDTHH:mm:ss'), 
      departureTime:lastPath.subLastPathTime.format('YYYY-MM-DDTHH:mm:ss'), 
      pathInfo: {pathType:lastPath.pathType, info:lastPath.info, subPath: finalPathResult}})
    // return res.status(200).send({ result: true })

  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false }) 
  }

})


async function getRailTimes(userTime, totalInfo, dayCode, transport_base_date) {

  try{
   
    if(totalInfo.length > 0) {
      
      const trainTimeList = await Promise.all(totalInfo.map(async (element) => {

        /**
         * 디비에서 원하는 지하철 정보를 넣어주면 정보를 뽑아내는 과정
         */
        const subwayCode = element.subwayCode
        const wayCode = element.wayCode
        const subwayName = element.subwayName
        const startID = element.startID
        const endID = element.endID
        const userTimeValue = parseInt(userTime.format("HHmm"))
        const transportYYYYMMDD = transport_base_date.format("YYYY-MM-DD")

        let rail_type= 'FALSE'
        if(subwayName.includes('급행') || subwayName.includes('특급')){
          rail_type= 'TRUE'
        }

        const SQL= `SELECT 역코드, 열차번호, 도착시간 FROM train_time WHERE (역코드 = ${startID} OR 역코드 = ${endID}) AND 요일 = ${dayCode} AND 방향 = ${wayCode} AND 급행선 = '${rail_type}';`
        
        const stationTimeList= await selectDataWithQuery(SQL)

        const temp = stationTimeList.map((element) =>{
            return {'역코드': element['역코드'], '열차번호': element['열차번호'], '도착시간': dayjs(transportYYYYMMDD+String(element['도착시간'], 'YYYYMMDDhhmm'))}
          })
          .filter((element)=>{ if(element['도착시간'].isAfter(userTime)){return true} else{return false} })

        if(temp.length <= 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(dayCode)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null} 
        }  
        
        const result = temp.reduce((accumulator, obj) => {
          const key = obj['역코드'];
          if (accumulator[key]) {
            accumulator[key].push(obj)
          } else {
            accumulator[key] = []
            accumulator[key].push(obj)
          }
          
          return accumulator;
        }, {})
        
        if(result[startID] === undefined || result[endID]=== undefined){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(dayCode)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null} 
        }
        if(result[startID].length !== 0 && result[endID].length !== 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(dayCode)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: result}
        } else {
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(dayCode)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null}
        }
      }))

      const result = {}
      trainTimeList.forEach((element) =>{
        result[element.stringKey] = element.time
      })

      return result
    } else {
      return null
    }
         
  } catch(err){
    console.log(err)
    throw(err)
  } 
}

async function getBusData(userTime, totalInfo, dayType, transport_base_date){
  try {
    
    if(totalInfo.length > 0){


      /**
       * 디비에서 버스 정보를 찾아 주는 과정
       */
      const len = totalInfo.length-1
      let term_sql = `SELECT busRouteId , ${dayType} FROM bus_term WHERE`
      totalInfo.forEach((element, index) => {
        if (index === len){
          term_sql +=` busRouteId = ${element.busLocalBlID};`
        } else {
          term_sql +=` busRouteId = ${element.busLocalBlID} OR`
        }
      })
      
      const term_result = await selectDataWithQuery(term_sql) 
      
      let bus_time_sql = 'SELECT stationId, busRouteId, lastTm FROM bus_last_time WHERE'
      totalInfo.forEach((element, index) => {
        if (index === len){
          bus_time_sql +=` (busRouteid = ${element.busLocalBlID} AND stationId =${element.startLocalStationID});`
        } else {
          bus_time_sql +=` (busRouteid = ${element.busLocalBlID} AND stationId =${element.startLocalStationID}) OR`
        }
      })

      const temp_result = await selectDataWithQuery(bus_time_sql)

      const bus_time_result = temp_result.map((element)=>{
        if(element.lastTm === null){
          return {busRouteId: element.busRouteId, lastTm: null}
        }
        if(parseInt(element.lastTm.replace(':','')) < 600){
          return { busRouteId: element.busRouteId, lastTm: dayjs(transport_base_date.format('YYYY-MM-DD')+element.lastTm,'YYYY-MM-DDHHmmss').add(1, 'd')}
        } else {
          return { busRouteId: element.busRouteId, lastTm: dayjs(transport_base_date.format('YYYY-MM-DD')+element.lastTm,'YYYY-MM-DDHHmmss')}
        }
      })
      .map((element)=>{
        if(element.lastTm === null){
          return element
        }
        if(userTime.isBefore(element.lastTm)){
          return element
        } else {
          return {busRouteId: element.busRouteId, lastTm: null}
        }
      })

      const result = {}
      term_result.forEach((element) => {
        if(element.day !== null && element.day !== undefined){
          result[element.busRouteId] = element.day
        } else {
          result[element.busRouteId] = null
        }
      })
      const final_result = {}
      bus_time_result.forEach((element)=>{
        if(element.lastTm !== null && element.lastTm !== undefined && result[element.busRouteId] !== undefined){
          final_result[element.busRouteId] = {busRouteId:element.busRouteId, term: result[element.busRouteId], lastTM: element.lastTm}
        } else {
          final_result[element.busRouteId] = null
        }
      })

      return final_result
    } else {
      return null
    }

  } catch (err){
    console.log(err)
    throw(err)
  }
}


async function selectDataWithQuery(sql){

  try{
    const conn = await mysql.getConnection()
    const [ result ] = await conn.query(sql)
    conn.release()
    return result
  } catch (err) {
    console.log(err)
    conn.release()
    throw(err)
  } 
}


function checkDateType(userTime){
  
  let date
  /**
   * 유저의 시간이 새벽 1시인 경우 버스는 그 전날의 요일이 무엇인지에 따라 배차간격등이 정해짐
   * 그래서 요일을 확인 하기 위해서는 24시 이전과 이후를 구분해야함
   * 새벽 4시를 기준으로 작으면 이전 날짜를 21시면 해당 날짜를 생성해 줌
   */
  if(parseInt(userTime.get('h')) <= 4){
    date = userTime.subtract(1,'d')
  } else {
    date = userTime
  }
  
  let day_type = date.day() === 0 ? 'sun_holiday' : date.day() === 6 ? 'sat' : 'day'
  const solar_holiday = ['0101', '0301', '0505','0606','0815','1003','1009','1225']
  const lunar_holiday = ['0527','0928','0929','0930']

  if(solar_holiday.includes(date.format('MMDD')) || lunar_holiday.includes(date.format('MMDD'))){
    day_type = 'sun_holiday'
  }

  return [day_type, date]
}

module.exports = {pathRouter}