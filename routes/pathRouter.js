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

const ODSAY_API_KEY = process.env.ODSAY_API_KEY

pathRouter.get('/getLastTimeAndPath', async(req, res) => {
  try{
    console.time('test')
    const time = req.query.time
    const startX = req.query.startX
    const startY = req.query.startY
    const endX = req.query.endX
    const endY = req.query.endY

      if(!time ||!startX || !startY || !endX || !endY){
        return res.status(400).send({ error: 'Request parameters are incorrect', result: false })
      }
    
    const userTime = dayjs(time);

    const routeResult = await axios.get(`https://api.odsay.com/v1/api/searchPubTransPathT?SX=${startX}`+
                                        `&SY=${startY}&EX=${endX}&EY=${endY}&apiKey=${ODSAY_API_KEY}`);
    
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
            lane : subElement.lane.map((e)=>{return e.subwayCode}),
            startName: subElement.startName,
            endName: subElement.endName,
            wayCode: subElement.wayCode,
            startID: subElement.startID,
            endID: subElement.endID}
        }
      })
    })

    /**버스 노선 중복 제거 한 것 */
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
    
    /**기차 노선 중복 제거 한 것 */
    const trainList = summarizedPaths.flat()
      .filter(element => element.trafficType === 1)
      .map((element)=>{
        const {lane, ...rest} = element
        return element.lane.map((code)=>{ return {subwayCode: code, ...rest} })})
      .flat()
      .reduce((accumulator, current) => {
        const res = accumulator.find(element => element.subwayCode === current.subwayCode && element.wayCode === current.wayCode 
                                    && element.startID === current.startID && element.endID === current.endID)
        if (res) {
          return accumulator
        } else {
          return accumulator.concat([current])
        }
      }, [])

    // console.time('test')
    const bus_term_time = await getBusData(userTime, busList)
    const train_time = await getRailTimes(userTime, trainList)

    /**
     * 경로들에 대해 막차 시간을 구하는 과정
     */
    const lastPaths = summarizedPaths.map((path)=>{

      // 막차 시간 구하기 위해 초기에 설정한 값 클라이언트에서 준 날짜에 하루 뒤 날짜를 생성함.
      let subLastPathTime = userTime.add(1, 'd')
  
      const subPathLength = path.length - 1

      /**getBusData
       * 각 서브 경로에 대해 막차 시간을 계산하는 구간
      */

      for(let i = subPathLength; i >= 0; i--){
        // if(subLastPathTime !== null){
        //   console.log(subLastPathTime.format())
        // } else {
        //   console.log('null발생')
        // }
        
        if(subLastPathTime !== null){

          if(path[i].trafficType === 3){
            // console.log('텀'+path[i].sectionTime)

            if(path[i].sectionTime == 0){
              subLastPathTime = subLastPathTime.subtract(10, 'm')
            } else{
              subLastPathTime = subLastPathTime.subtract(path[i].sectionTime, 'm')
            }
          } else if(path[i].trafficType === 2) {
            const busLaneList = path[i].lane.map((element)=>{
              if(bus_term_time[element] !== undefined && bus_term_time[element] !== null){
                return bus_term_time[element]
              } else {
                // console.log('e')
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
  
              if(busLastTime.isSameOrBefore(subLastPathTime)){
                // console.log('버스'+busLastTime,path[i].sectionTime, bus_data.term)
                subLastPathTime = busLastTime.subtract(path[i].sectionTime,'m').subtract(bus_data.term,'m')
              }
            } else {
              // console.log('d')
              subLastPathTime = null
            }
          } else {
            
            const keyString = String(path[i].lane[0])+'-'+String(path[i].wayCode)+
                                    '-'+String(path[i].startID)+'-'+String(path[i].endID)
            
            if (train_time[keyString] !== undefined && train_time[keyString] !== null) {

              const endStationLastRail = train_time[keyString][path[i].endID].filter((element) => { 
                if(element['도착시간'].isBefore(subLastPathTime)) {
                  return true
                } else {
                  return false
                }
              })
              
              if(endStationLastRail.length > 0) {
                const tempEndStationLastRail = endStationLastRail.reduce((prev, now) => { 
                  if(prev['도착시간'].isAfter(now['도착시간'])) {
                    return prev
                  } else {
                    return now
                  }
                })

                const startStationLastRail = train_time[keyString][path[i].startID].filter((element)=> {
                  if(element['열차번호'] === tempEndStationLastRail['열차번호']) {
                    return true
                  } else{
                    return false
                  }
                })
    
                if (startStationLastRail.length > 0){
                  
                  const newLastPathTime = startStationLastRail.reduce((prev, now) => { 
                    if(prev['도착시간'].isAfter(now['도착시간'])) {
                      return prev
                    } else {
                      return now
                    }
                  })
  
                  if(newLastPathTime['도착시간'].isBefore(subLastPathTime)){
                    // console.log('지하철'+newLastPathTime['도착시간'].format())
                    subLastPathTime = newLastPathTime['도착시간']
                  }
                
                } else {
                  // console.log('a')
                  subLastPathTime =  null
                }

              } else {
                // console.log('b')
                subLastPathTime =  null
              }
              

            } else {
              // console.log('c')
              subLastPathTime =  null
            }
          }
        }
      }
      console.log('-----------------------------------')
      
      return {
        'path': path,
        'subLastPathTime': subLastPathTime
      }
    })

    // console.log(lastPaths)

    // 길이 체크 해야함
    let minIndex = 0
    const filteredLastPaths = lastPaths.filter(element=> element.subLastPathTime)
    
    if(filteredLastPaths.length > 0){

      const lastPath = filteredLastPaths.reduce((prev, now, index) => {
        if(prev.subLastPathTime.isSameOrAfter(now.subLastPathTime)) {
          return prev
        } else {
          minIndex = index
          return now
        }
      })

      // console.log(lastPath)
    
    /**
     * 위에서 구한 마지막의 막차에 대한 걸리는 시간을 다시 연산하는 작업 
     */
    
    let arrivalTime = lastPath.subLastPathTime

    const {subPath, ...rest} = routeResult.data.result.path[minIndex]
    const subPathRes = subPath.map( (path) => {
      if(path.trafficType === 3){

        if(path.sectionTime == 0){
          arrivalTime = arrivalTime.add(10, 'm')
        } else{
          arrivalTime = arrivalTime.add(path.sectionTime, 'm')
        }
        return path

      } else if(path.trafficType === 2) {

        const busLaneList = path.lane.map((element)=>{
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
        
          arrivalTime = arrivalTime.add(path.sectionTime,'m').add(bus_data.term,'m')
          path.lane = path.lane.filter((element)=>{
            return String(element.busLocalBlID) === String(bus_data.busRouteId)
          })
          return path
        }
      } else {
        arrivalTime = arrivalTime.add(path.sectionTime,'m')
        return path
      }
    })
    
    console.timeEnd('test')

    return res.status(200).send({
      pathExistence: true,
      arrivalTime: arrivalTime.format('YYYY-MM-DDTHH:mm:ss'), 
      departureTime:lastPath.subLastPathTime.format('YYYY-MM-DDTHH:mm:ss'), 
      pathInfo: {...rest, subPath: subPathRes}})

    } else {
      return res.status(200).send({
        pathExistence: false,
        arrivalTime: null, 
        departureTime:null, 
        pathInfo: null})
    }
     
  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false }) 
  }

})


async function getRailTimes(userTime, totalInfo) {

  try{
    /**
     * 호선, 지하철코드, 방향 정보 info에 필요
     */

    if(totalInfo.length > 0) {
      
      const trainTimeList = await Promise.all(totalInfo.map(async (element) => {
        let [dayCd, transport_date] = checkDateType(userTime)
        const DC = dayCd === 'day'? 1 : dayCd === 'sat' ? 2 : 3

        const subwayCode = element.subwayCode
        const wayCode = element.wayCode
        const start_station_name = element.startName
        const startID = element.startID
        const endID = element.endID
        const userTimeValue = parseInt(userTime.format("HHmm"))
        const transportYYYYMMDD = transport_date.format("YYYY-MM-DD")
        let rail_type= 'FALSE'
        if(start_station_name.includes('급행')||start_station_name.includes('특급')){
          rail_type= 'TRUE'
        }

        const SQL= `SELECT 역코드, 열차번호, 도착시간 FROM train_time WHERE (역코드 = ${startID} OR 역코드 = ${endID}) AND 요일 = ${DC} AND 방향 = ${wayCode} AND 급행선 = '${rail_type}';`
        
        const stationTimeList= await selectDataWithQuery(SQL)

        const result = stationTimeList.map((element) =>{
            return {'역코드': element['역코드'], '열차번호': element['열차번호'], '도착시간': dayjs(transportYYYYMMDD+String(element['도착시간'], 'YYYYMMDDhhmm'))}
          })
          .filter((element)=>{ if(element['도착시간'].isAfter(userTime)){return true} else{ return false} })
          .reduce((accumulator, obj) => {
          const key = obj['역코드'];
          if (accumulator[key]) {
            accumulator[key].push(obj)
          } else {
            accumulator[key] = []
          }
          
          return accumulator;
        }, {})

        if(result[startID] === undefined || result[endID]=== undefined){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(startID)+'-'+String(endID), time: null} 
        }
        if(result[startID].length !== 0 && result[endID].length !== 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(startID)+'-'+String(endID), time: result}
        } else {
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(startID)+'-'+String(endID), time: null}
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

async function getBusData(userTime, totalInfo){
  try {
    
    const [day_type, transport_date] = checkDateType(userTime)

    if(totalInfo.length > 0){

      const len = totalInfo.length-1
      let term_sql = `SELECT busRouteId , ${day_type} FROM bus_term WHERE`
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
          return { busRouteId: element.busRouteId, lastTm: dayjs(transport_date.format('YYYY-MM-DD')+element.lastTm,'YYYY-MM-DDHHmmss').add(1, 'd')}
        } else {
          return { busRouteId: element.busRouteId, lastTm: dayjs(transport_date.format('YYYY-MM-DD')+element.lastTm,'YYYY-MM-DDHHmmss')}
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
        if(element.day !== null){
          result[element.busRouteId] = element.day
        } else {
          result[element.busRouteId] = null
        }
      })
      bus_time_result.forEach((element)=>{
        if(element.lastTm !== null){
          result[element.busRouteId] = {busRouteId:element.busRouteId, term: result[element.busRouteId], lastTM: element.lastTm}
        } else {
          result[element.busRouteId] = null
        }
      })

      return result
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
  
  const day_type = date.day() === 0 ? 'sun_holiday' : date.day() === 6 ? 'sat' : 'day'
  const solar_holiday = ['0101', '0301', '0505','0606','0815','1003','1009','1225']
  const lunar_holiday = ['0527','0928','0929','0930']

  if(solar_holiday.includes(date.format('MMDD')) || lunar_holiday.includes(date.format('MMDD'))){
    day_type = 'sun_holiday'
  }

  return [day_type, date]
}

module.exports = {pathRouter}