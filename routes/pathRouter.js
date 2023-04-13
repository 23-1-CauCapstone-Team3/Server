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

    const routeResult = await axios.get(`https://api.odsay.com/v1/api/searchPubTransPathT?SX=${startX}&SY=${startY}&EX=${endX}&EY=${endY}&apiKey=${ODSAY_API_KEY}`)
    

    /**
     * 경로들에 대해 막차 시간을 구하는 과정
     */
  
    let subLatestPathTime 
    let walkTime // 분 단위

    const latestPath = routeResult.data.result.path.map((path)=>{
      subLatestPathTime = moment(userTime).add(1, 'd')

      const subPathLength = path.subPath.length - 1

      /**
       * 각 서브 경로에 대해 막차 시간을 계산하는 구간
       */
      for(let i = subPathLength; i >= 0; i--){
        if(path.subPath[i].trafficType === 3){
          walkTime = path.subPath[i].sectionTime
          subLatestPathTime.subtract(walkTime, 'm')
        } else if(path.subPath[i].trafficType === 2) {
          getBusTermTime(userTime, info)
          getBusLastTime()
        } else {
          getRailTimes(userTime)
        }
      }

      return {
        'path': path,
        'subLatestPathTime': subLatestPathTime
      }
    }).reduce((prev, now) => { return prev.subLatestPathTime > now.subLatestPathTime ? now : prev})



    /**
     * 위에서 구한 마지막의 막차에 대한 걸리는 시간을 다시 연산하는 작업 
     */
    
    let arrivalTime = latestPath.subLatestPathTime

    latestPath.path.map((path) => {
      if(path.trafficType === 3){
        walkTime = path.sectionTime
        arrivalTime.add(walkTime, 'm')
      } else if(path.trafficType === 2) {
        getBusTermTime(userTime, info)
        getBusLastTime(info)
      } else {
        getRailTimes(userTime, info)
      }
    })

    return res.status(200).send(routeResult.data.result) 

  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false }) 
  }

})


async function getRailTimes(userTime, info) {

  try{

    let dayCd
    /**
     * 호선, 지하철코드, 방향 정보 info에 필요
     */
    const lnCd = info.d
    const station_name = info.n
    const way_code = info.w
    const userYYYYMMDD = userTime.format("YYYY-MM-DD")
    const userHHmmss = userTime.format("HHmmss")
    const dawnHHmmss = '040000'

    const sql = `SELECT rail_comp_code, station_code FROM rail_info WHERE rail_line_code = '${lnCd}' AND station_name = '${station_name}';`

    const results = await selectDataWithQuery(sql) 

    if(!results) {
      return null
    }

    const railOprIsttCd = results[0].rail_comp_code;
    const stinCd = results[0].station_code;



    /**
     * 날짜 확인 필요
     */

    dayCd = userTime.day() === 0 ? 9 : userTime.day() === 6 ? 7 : 8


    /**
     * 지하철 시간표를 데이터만들게 되면 대부분 수정해야한다는 점을 인지
     * 현재는 api로 2번최대 2번 받아오는 형식
     */

    if (userTime.hours() > 20 && userTime.hours() < 24){

      const res1 = await axios.get(`https://openapi.kric.go.kr/openapi/convenientInfo/stationTimetable?serviceKey=${SUB_STATION_API_KEY}&format=json&railOprIsttCd=${railOprIsttCd}&lnCd=${lnCd}&stinCd=${stinCd}&dayCd=${dayCd}`)
      
      /**
       * 날짜 확인 필요
       */
      dayCd = userTime.day() + 1 === 0 ? 9 : userTime.day() + 1 === 6 ? 7 : 8

      const res2 = await axios.get(`https://openapi.kric.go.kr/openapi/convenientInfo/stationTimetable?serviceKey=${SUB_STATION_API_KEY}&format=json&railOprIsttCd=${railOprIsttCd}&lnCd=${lnCd}&stinCd=${stinCd}&dayCd=${dayCd}`)
      
      let results
      if(res1.data.body && res2.data.body){
        results = [...res1.data.body.filter((element) => { return parseInt(element.arvTm, 10) >= userHHmmss}),
           ...res2.data.body.filter((element) => { return parseInt(element.arvTm, 10) <= dawnHHmmss})]
      } else if (!res1.data.body && res2.data.body) {
        results = res2.data.body.filter((element) => { return parseInt(element.arvTm, 10) <= dawnHHmmss})
      } else if (res1.data.body && !res2.data.body) {
        results = res1.data.body.filter((element) => { return parseInt(element.arvTm, 10) >= userHHmmss})
      } else{
        return null
      }
      

      return results.map((element) => {
            if(parseInt(element.arvTm, 10) >= userHHmmss){
              return {
                'arvTm': moment(userYYYYMMDD + element.arvTm, 'YYYY-MM-DDHHmmss'),
                'tmnStinCd': element.tmnStinCd
              }
            } else {
              return {
                'arvTm': moment(userYYYYMMDD + element.arvTm, 'YYYY-MM-DDHHmmss').add(1,'d'),
                'tmnStinCd': element.tmnStinCd
              }
            }
          })

    } else{
      const results = await axios.get(`https://openapi.kric.go.kr/openapi/convenientInfo/stationTimetable?serviceKey=${SUB_STATION_API_KEY}&format=json&railOprIsttCd=${railOprIsttCd}&lnCd=${lnCd}&stinCd=${stinCd}&dayCd=${dayCd}`)
      
      if(!results.data.body) {
        return null
      }

      return results.data.body.filter((element)=>{
        return parseInt(element.arvTm ,10) <= dawnHHmmss && parseInt(element.arvTm ,10) >= userHHmmss
      }).map((element) => ({
        'arvTm': moment(userYYYYMMDD + element.arvTm, 'YYYY-MM-DDHHmmss'),
        'tmnStinCd': element.tmnStinCd
      }))
    }
  } catch(err){
    console.log(err)
    throw(err)
  } 
}

async function getBusTermTime(userTime, info){
  try {
    /**
     * 버스 아이디필요
     * 날짜 확인 필요
     */
    const bus_ID = info.i

    const day_type =  userTime.day() === 0 ? 'sun_holiday' : userTime.day() === 6 ? 'sat' : 'day'
    
    /**
     * 배차 간격 데이터를 만들게 되면 수정해야하는 곳
     */
    const sql = `SELECT ${day_type} FROM bus_term WHERE route_id = ${bus_ID};`

    const result = await selectDataWithQuery(sql) 

    return result[0][day_type]
  } catch (err){
    console.log(err)
    throw(err)
  }
}

async function getBusLastTime(info) {
  try{

    /** 버스경로 아이디 정류장 아이디 필요 
     *  버스 경로에 대한 막차 시간 데이터를 얻게 되면 다시 수정해야함 sql 형태로 
    */
    const arsID = info.arsID
    const busRouteID = info.busRouteID
    const result = await axios.get(`http://ws.bus.go.kr/api/rest/stationinfo/getBustimeByStation?ServiceKey=${BUS_STATION_API_KEY}&arsId=${arsID}&busRouteId=${busRouteID}&resultType=json`)
    
    if(result.msgBody.itemList){
      return result.msgBody.itemList.lastBusTm
    } else {
      return null
    }
  } catch(err){
    console.log(err)
    throw(err)
  }
}

async function selectDataWithQuery(sql){

  try{
    const conn = await mysql.getConnection()
    const [ result ] = await conn.query(sql)
    return result
  } catch (err) {
    console.log(err)
    throw(err)
  } finally {
    conn.release()
  }
}


async function checkHoliday(date){

  /**
   * 공휴일을 확인하거나 그냥 날짜를 입력받으면 평일 토요일 공휴일로 구분해주도록할 함수
   * 작성해야함
   */
}

module.exports = {pathRouter}