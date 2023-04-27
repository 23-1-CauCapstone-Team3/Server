const { Router } = require('express')
const axios = require('axios')
const moment = require('moment')
require("dotenv").config();

const mysql = require('../mysql/mysql')  // mysql 모듈 로드

pathRouter = Router()

const SK_API_KEY = process.env.SK_API_KEY
const ODSAY_API_KEY = process.env.ODSAY_API_KEY

const BUS_TERM_TIME_API_KEY = process.env.BUS_TERM_TIME_API_KEY
const BUS_STATION_API_KEY =  process.env.BUS_STATION_API_KEY
const SUB_STATION_API_KEY = process.env.SUB_STATION_API_KEY

// const day_type = {
//   day: 1,
//   sat: 2,
//   sun_holiday: 3
// }
// Object.freeze(day_type);

pathRouter.post('/', async(req, res) => {
  try{
    const time = req.query.time
    const startX = req.query.startX
    const startY = req.query.startY
    const endX = req.query.endX
    const endY = req.query.endY

      if(!time ||!startX || !startY || !endX || !endY){
        return res.status(400).send({ error: 'Request parameters are incorrect', result: false })
      }
    
    const userTime = moment(time);

    const routeResult = await axios.get(`https://api.odsay.com/v1/api/searchPubTransPathT?SX=${startX}`+
                                        `&SY=${startY}&EX=${endX}&EY=${endY}&apiKey=${ODSAY_API_KEY}`)
    

    /**
     * 경로들에 대해 막차 시간을 구하는 과정
     */
  
    const lastPaths = await Promise.all(routeResult.data.result.path.map(async (path)=>{

      // 막차 시간 구하기 위해 초기에 설정한 값 클라이언트에서 준 날짜에 하루 뒤 날짜를 생성함.
      let subLastPathTime = moment(userTime).add(1, 'd')
      // console.log(subLastPathTime)
    
      const subPathLength = path.subPath.length - 1

      /**getBusData
       * 각 서브 경로에 대해 막차 시간을 계산하는 구간
      */

      for(let i = subPathLength; i >= 0; i--){
        if(path.subPath[i].trafficType === 3){
          // subLastPathTime.subtract(path.subPath[i].sectionTime, 'm')
          // console.log(subLastPathTime)
          // console.log(path.subPath[i].sectionTime)
        } else if(path.subPath[i].trafficType === 2) {

          const busList = await Promise.all(path.subPath[i].lane.map(async(element)=>{
            const info = {
              busLocalBlID: element.busLocalBlID,
              startArsID: path.subPath[i].startArsID.replace('-',''),
              startLocalStationID: path.subPath[i].startLocalStationID
            }
            result = await getBusData(userTime, info)
            return result
          }))

          if(busList.filter(element => element).length > 0) {

            const bus_data = busList.reduce((prev, now) => {
              if(prev.time.isSameOrAfter(now.time)) {
                return prev
              } else {
                return now
              }
            })
            
            const busLastTime = bus_data.time
            
            if(busLastTime.isSameOrBefore(subLastPathTime)){
              subLastPathTime = busLastTime
              subLastPathTime.subtract(path.subPath[i].sectionTime,'m')
              subLastPathTime.subtract(bus_data.term,'m')
            }
          }

        } else {
          const info = {
            lnCd:path.subPath[i].lane[0].subwayCode,
            startName: path.subPath[i].startName,
            endName: path.subPath[i].endName,
            wayCode: path.subPath[i].wayCode,
            startID: path.subPath[i].startID,
            endID: path.subPath[i].endID,
          }

          const timeListResults = await getRailTimes(userTime, info)
          
          if (timeListResults) {
            const endStationLastRail = timeListResults.endStationTimeList.reduce((prev, now) => { 
              if(prev.arvTm.isBefore(subLastPathTime) && prev.arvTm.isAfter(now.arvTm)) {
                return prev
              } else {
                return now
              }
            })
            
            const startStationLastRail = timeListResults.startStationTimeList.filter((element)=> {
              if(element.trnNo === endStationLastRail.trnNo) {
                return true
              } else{
                return false
              }
            }).reduce((prev, now) => { 
              if(prev.arvTm.isBefore(subLastPathTime) && prev.arvTm.isAfter(now.arvTm)) {
                return prev
              } else {
                return now
              }
            })
            subLastPathTime = startStationLastRail.arvTm
          }
        }
      }
      return {
        'path': path,
        'subLastPathTime': subLastPathTime
      }
    })
    )

    // console.log(lastPaths.reduce((prev, now) => { 
    //   if(prev.subLastPathTime.isSameOrBefore(now.subLastPathTime)) {
    //     return prev
    //   } else {
    //     return now
    //   }
    // }))

    const lastPath = lastPaths.reduce((prev, now) => { 
      if(prev.subLastPathTime.isSameOrBefore(now.subLastPathTime)) {
        return prev
      } else {
        return now
      }
    })

    /**
     * 위에서 구한 마지막의 막차에 대한 걸리는 시간을 다시 연산하는 작업 
     */
    
    let arrivalTime = moment(lastPath.subLastPathTime)

    await Promise.all(lastPath.path.subPath.map(async (path) => {
      if(path.trafficType === 3){
        walkTime = path.sectionTime
        arrivalTime.add(walkTime, 'm')
      } else if(path.trafficType === 2) {
        const busList = await Promise.all(path.lane.map(async(element)=>{
          const info = {
            busLocalBlID: element.busLocalBlID,
            startArsID: path.startArsID.replace('-',''),
            startLocalStationID: path.startLocalStationID
          }
          result = await getBusData(userTime, info)
          return result
        }))

        if(busList.filter(element => element).length > 0) {

          const bus_data = busList.reduce((prev, now) => {
            if(prev.time.isSameOrAfter(now.time)) {
              return prev
            } else {
              return now
            }
          })

          arrivalTime.add(path.sectionTime,'m')
          arrivalTime.add(bus_data.term,'m')
        }
      } else {
        arrivalTime.add(path.sectionTime,'m')
      }
    }))

    return res.status(200).send({arrivalTime: arrivalTime.format('YYYY-MM-DDTHH:mm:ss'), departureTime:lastPath.subLastPathTime.format('YYYY-MM-DDTHH:mm:ss'), pathInfo: lastPath.path}) 

  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false }) 
  }

})


async function getRailTimes(userTime, info) {

  try{
    /**
     * 호선, 지하철코드, 방향 정보 info에 필요
     */
    const start_station_name = info.startName
    const end_station_name= info.endName
    const lnCd = info.lnCd
    const wayCode = info.wayCode
    const startID = info.startID
    const endID = info.endID
    let rail_type = 'G'
    const userHHmm = userTime.format("HHmm")
    const dawnHHmm = '0300'

    let [dayCd, transport_date] = checkDateType(userTime)
    const DC = dayCd === 'day'? 1 : dayCd === 'sat' ? 2 : 3
    const transportYYYYMMDD = transport_date.format("YYYY-MM-DD")
    const afterDayTransportYYYYMMDD = moment(transport_date).add(1,'d').format('YYYY-MM-DD')

    if(start_station_name.includes('급행')||start_station_name.includes('특급')){
      rail_type= 'D'
    }
    const startStationSQL = `SELECT 도착시간, 열차번호 FROM rail_time WHERE 외부코드 = ${startID} AND 요일 = ${DC} AND 방향 = ${wayCode} AND 급행선 = '${rail_type}';`
    const startRailTime= await selectDataWithQuery(startStationSQL)
    const endStationSQL = `SELECT 도착시간, 열차번호 FROM rail_time WHERE 외부코드 = ${endID} AND 요일 = ${DC} AND 방향 = ${wayCode} AND 급행선 = '${rail_type}';`
    const endRailTime = await selectDataWithQuery(endStationSQL)
    
    if(startRailTime.length !== 0 && endRailTime.length !== 0) {

      const res2 = endRailTime.filter( element => {
        return parseInt(element['도착시간'].replace(':','')) > parseInt(userHHmm)}
        ).map((element) => {
          timeStr = element['도착시간'].replace(':','').substr(0,4)
          if (parseInt(timeStr) >= 2400 ){
            const t = parseInt(timeStr) - 2400
            return {trnNo:element['열차번호'], arvTm: moment(afterDayTransportYYYYMMDD + String(t).padStart(4, '0'), 'YYYY-MM-DDHHmm')}
          } else {
            return {trnNo:element['열차번호'], arvTm: moment(transportYYYYMMDD + timeStr, 'YYYY-MM-DDHHmm')}
          }
        })
        
      
      const res1 = startRailTime.filter( element => {
        return parseInt(element['도착시간'].replace(':','')) > parseInt(userHHmm)}
        ).map((element) => {
          timeStr = element['도착시간'].replace(':','').substr(0,4)
          if (parseInt(timeStr) >= 2400 ){
            const t = parseInt(timeStr) - 2400
            return {trnNo:element['열차번호'], arvTm: moment(afterDayTransportYYYYMMDD + String(t).padStart(4, '0'), 'YYYY-MM-DDHHmm')}
          } else {
            return {trnNo:element['열차번호'], arvTm: moment(transportYYYYMMDD + timeStr, 'YYYY-MM-DDHHmm')}
          }
        })

      return {startStationTimeList:res1, endStationTimeList:res2}
    } else{
      return null
    }
    
  } catch(err){
    console.log(err)
    throw(err)
  } 
}

async function getBusData(userTime, info){
  try {

    const arsID = info.startArsID
    const busRouteID = info.busLocalBlID

    const [day_type, transport_date] = checkDateType(userTime)

    const sql = `SELECT ${day_type} FROM bus_term WHERE route_id = ${busRouteID};`

    const term_result = await selectDataWithQuery(sql) 

    if(term_result.length !== 1){
      return null
    } 

    /**
     *  버스 경로에 대한 막차 시간 데이터를 얻게 되면 다시 수정해야함 sql 형태로 
    */
    const time_result = await axios.get(`http://ws.bus.go.kr/api/rest/stationinfo/getBustimeByStation?ServiceKey=${BUS_STATION_API_KEY}&arsId=${arsID}&busRouteId=${busRouteID}&resultType=json`)
   
    if(time_result.data.msgBody.itemList.length !== 1){
      return null
    } 

    if(!time_result.data.msgBody.itemList[0].lastBusTm) {
      return null
    }

    if(parseInt(time_result.data.msgBody.itemList[0].lastBusTm) < 40000 ){
      return {term: term_result[0][day_type], time: moment(transport_date.format('YYYY-MM-DD')+time_result.data.msgBody.itemList[0].lastBusTm, 'YYYY-MM-DDHHmmss').add(1, 'd')}
    } else if(parseInt(time_result.data.msgBody.itemList[0].lastBusTm) > parseInt(userTime.format('HHmmss')) ) {
      return {term: term_result[0][day_type], time: moment(transport_date.format('YYYY-MM-DD')+time_result.data.msgBody.itemList[0].lastBusTm, 'YYYY-MM-DDHHmmss')}
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
  if(parseInt(userTime.format('hh')) <= 4){
    date = moment(userTime).subtract(1,'d')
  } else {
    date = moment(userTime)
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