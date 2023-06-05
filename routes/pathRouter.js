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

            if(path[i].sectionTime == 0){
              path[i].sectionTime = 10
              subLastPathTime = subLastPathTime.subtract(10 + walk_alpha, 'm')
              console.log('텀: '+(10 + walk_alpha))
            } else{
              subLastPathTime = subLastPathTime.subtract(path[i].sectionTime+walk_alpha, 'm')
              console.log('텀: '+(path[i].sectionTime+walk_alpha))
            }
          } else if(path[i].trafficType === 2) {

            console.log('버스-'+path[i].sectionTime)

            // 여러 버스 노선들을 각각에 맞는 정보로 바꿔주는 작업
            const busLaneList = path[i].lane.map((element)=>{
              
              const stringKey = String(path[i].startLocalStationID)+'-'+String(element.busLocalBlID)
              console.log(stringKey)

              if(bus_term_time[stringKey] !== undefined && bus_term_time[stringKey] !== null){
                return bus_term_time[stringKey]
              } else {
                return null
              }
            })

            // 변환한 정보들 중 디비에 없는 데이터들로만 구성된 경우 계산 불가임. 그래서 바로 null 반환 
            if(busLaneList.filter(element => element).length < 1){
              subLastPathTime = null
              console.log('디비에 원하는 버스 정보가 없음')
              break
            }

            // 변환한 정보 중 가장 늦은 막차시간을 가진 버스 정보를 고르는 과정
            const bus_data = busLaneList.filter(element => element).reduce((prev, now) => {
              if(prev.time.isSameOrAfter(now.time)) {
                return prev
              } else {
                return now
              }
            })
            
            const busLastTime = bus_data.time

            console.log(busLastTime.format())

            // 이전 막차 시간보다 이후인 경우는 (걸리는 시간 + 알파) 값을 빼주고 이전 막차시간보다 이전인 경우는 새로 막차시간을 설정 후 (걸리는 시간 + 알파) 값을 빼 줌 
            if(busLastTime.isSameOrBefore(subLastPathTime)) {
              console.log('버스: '+busLastTime.format(),path[i].sectionTime, bus_data.term)
              subLastPathTime = busLastTime.subtract(path[i].sectionTime,'m').subtract(bus_data.term,'m').subtract(bus_alpha,'m')
            } else {
              console.log('버스: '+busLastTime.format(),path[i].sectionTime, bus_data.term)
              subLastPathTime = subLastPathTime.subtract(path[i].sectionTime,'m').subtract(bus_data.term,'m').subtract(bus_alpha,'m')
            }

            // 마지막에 선택된 노선의 정보들을 저장해줌 
            path[i].busTerm = bus_data.term
            path[i].lane = path[i].lane.filter(element => element.busLocalBlID === String(bus_data.route_id))
            path[i].lane.departureTime = subLastPathTime.format()

          } else {
            console.log('지하철'+path[i].sectionTime)

            const numberLine = [1, 2, 3, 4, 5, 6, 7, 8, 9]

            let rail_type= 0
            if(path[i].lane[0].name.includes('급행') || path[i].lane[0].name.includes('특급')){
              rail_type= 1
            }

            let DC = dayCode
            if (dayCode === 3 && !numberLine.includes(path[i].lane[0].subwayCode)){
              DC = 2
            }
            
            const keyString = String(path[i].lane[0].subwayCode)+'-'+String(path[i].wayCode)+'-'+String(DC)+'-'
            +String(rail_type)+'-'+String(path[i].startID)+'-'+String(path[i].endID)

            console.log(keyString)

            if (train_time[keyString] !== undefined && train_time[keyString] !== null) {
              
              const endStationRail = train_time[keyString][path[i].endID].filter((element) => { 
                if(element.time.isBefore(subLastPathTime)) {
                  return true
                } else {
                  return false
                }
              })
              
              if(endStationRail.length > 0) {
                const endStationLastRail = endStationRail.reduce((prev, now) => { 
                  if(prev.time.isAfter(now.time)) {
                    return prev
                  } else {
                    return now
                  }
                })

                console.log('도착지'+endStationLastRail.time.format())

                const startStationLastRail = train_time[keyString][path[i].startID].filter((element)=> {
                  
                  if(element.train_id === endStationLastRail.train_id && element.time.isBefore(endStationLastRail.time)) {
                    return true
                  } else{
                    return false
                  }
                })
                

                if (startStationLastRail.length > 0){
                  startStationLastRail.map((e)=>{console.log(e.time.format())})
                  
                  const newLastPathTime = startStationLastRail.reduce((prev, now) => { 
                    if(prev.time.isAfter(now.time)) {
                      return prev
                    } else {
                      return now
                    }
                  })
                  
                  console.log('지하철 :'+newLastPathTime.time.format())
                  subLastPathTime = newLastPathTime.time
                  path[i].lane[0].departureTime = subLastPathTime.format()
                  path[i].lane[0].arrivalTime = endStationLastRail.time.format()
                
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
    
    if(lastPaths.length == 0){
      return res.status(200).send({
        pathExistence: false,
        arrivalTime: null, 
        departureTime:null, 
        pathInfo: null})
    }
    
    /**
     * 가장 늦은 시간을 골라낸다.
     */
    const lastPath = lastPaths.reduce((prev, now) => {
        
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
        const term = bus_term_time[path.startLocalStationID+'-'+path.lane[0].busLocalBlID].term
        arrivalTime = arrivalTime.add(path.sectionTime,'m').add(term,'m').add(bus_alpha, 'm')
          
      } else {

        const numberLine = [1, 2, 3, 4, 5, 6, 7, 8, 9]

        let rail_type= 0
        if(path.lane[0].name.includes('급행') || path.lane[0].name.includes('특급')){
          rail_type= 1
        }

        let DC = dayCode
        if (dayCode === 3 && !numberLine.includes(path.lane[0].subwayCode)){
          DC = 2
        }
        
        const keyString = String(path.lane[0].subwayCode)+'-'+String(path.wayCode)+'-'+String(DC)+'-'
        +String(rail_type)+'-'+String(path.startID)+'-'+String(path.endID)

        const startTimeInfo = train_time[keyString][path.startID].filter((element)=>{
          if(arrivalTime.isBefore(element.time)){
            return true
          } else {
            return false
          }
        })

        for (let i =0; i<startTimeInfo.length;i++){
          const endWithSameTrain = train_time[keyString][path.endID].filter((element)=>{
            if(element.time.isAfter(startTimeInfo[i].time) && element.train_id === startTimeInfo[i].train_id){
              return true
            } else {
              return false
            }
          })

          if(endWithSameTrain.length !== 0){
            const endTimeInfo = endWithSameTrain.reduce((prev, now)=>{
              if(prev.time.isSameOrBefore(now.time)) {
                return prev
              } else {
                return now
              }
            })

            path.lane[0].arrivalTime = endTimeInfo.time.format()
            path.lane[0].departureTime = startTimeInfo[i].time.format()
            break
          }
          
        }
              
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
    // const finalPathResult = await Promise.all(lastPath.path.map(async (element)=>{
      
    //   if(element.trafficType === 3 || element.trafficType === 4){

    //     const options = {
    //       method: 'POST',
    //       url: 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&callback=function',
    //       headers: {
    //         accept: 'application/json',
    //         'content-type': 'application/json',
    //         appKey: SK_API_KEY
    //       },
    //       data: {
    //         startX: element.startX,
    //         startY: element.startY,
    //         angle: 20,
    //         speed: 30,
    //         endX: element.endX,
    //         endY: element.endY,
    //         reqCoordType: 'WGS84GEO',
    //         startName: encodeURIComponent(element.startName),
    //         endName: encodeURIComponent(element.endName),
    //         searchOption: '0',
    //         resCoordType: 'WGS84GEO',
    //         sort: 'index'
    //       }
    //     }

    //     const walkRoute = await axios.request(options)
        
    //     element.step = walkRoute.data.features
        
    //   }
    //   return element
    // }))

    console.timeEnd('test')
    console.log('******************************')
    
    return res.status(200).send({
      pathExistence: true,
      arrivalTime: arrivalTime.format('YYYY-MM-DDTHH:mm:ss'), 
      departureTime:lastPath.subLastPathTime.format('YYYY-MM-DDTHH:mm:ss'), 
      pathInfo: {pathType:lastPath.pathType, info:lastPath.info, subPath: lastPath.path}})
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
        const numberLine = [1, 2, 3, 4, 5, 6, 7, 8, 9]

        let rail_type= 0
        if(subwayName.includes('급행') || subwayName.includes('특급')){
          rail_type= 1
        }

        let DC = dayCode
        if (dayCode === 3 && !numberLine.includes(subwayCode)){
          DC = 2
        }

        const SQL= `SELECT stat_id, train_id, time FROM train_time WHERE (stat_id = ${startID} OR stat_id = ${endID}) AND week = ${DC} AND way = ${wayCode} AND is_direct = ${rail_type};`
        
        const stationTimeList= await selectDataWithQuery(SQL)

        const temp = stationTimeList.map((element) =>{
            return {'stat_id': element.stat_id, 'train_id': element.train_id, 'time': dayjs(transportYYYYMMDD+String(element.time, 'YYYYMMDDhhmm'))}
          })

        // 검색되는 것이 없다면 null 반환
        if(temp.length <= 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(DC)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null} 
        }  
        
        //역코드를 이용하여 출발역 시간과 도착역 시간 분리
        const result = temp.reduce((accumulator, obj) => {
          const key = obj.stat_id;
          if (accumulator[key]) {
            accumulator[key].push(obj)
          } else {
            accumulator[key] = []
            accumulator[key].push(obj)
          }
          
          return accumulator;
        }, {})
        
        if(result[startID] === undefined || result[endID]=== undefined){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(DC)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null} 
        }
        if(result[startID].length !== 0 && result[endID].length !== 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(DC)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: result}
        } else {
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(DC)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null}
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
       * 디비에서 버스 배차 정보를 찾아 주는 과정
       */
      const len = totalInfo.length-1
      let term_sql = `SELECT route_id , ${dayType} as term FROM bus_term WHERE`
      totalInfo.forEach((element, index) => {
        if (index === len){
          term_sql +=` route_id = ${element.busLocalBlID};`
        } else {
          term_sql +=` route_id = ${element.busLocalBlID} OR`
        }
      })
      
      const term_result = await selectDataWithQuery(term_sql) 
      
      let bus_time_sql = 'SELECT stat_id, route_id, time FROM bus_last_time WHERE'
      totalInfo.forEach((element, index) => {
        if (index === len){
          bus_time_sql +=` (route_id = ${element.busLocalBlID} AND stat_id =${element.startLocalStationID});`
        } else {
          bus_time_sql +=` (route_id = ${element.busLocalBlID} AND stat_id =${element.startLocalStationID}) OR`
        }
      })

      const temp_result = await selectDataWithQuery(bus_time_sql)

      const bus_time_result = temp_result.map((element)=>{
        if(element.time === null || element.time === undefined){
          return {stat_id: element.stat_id, route_id: element.route_id, time: null}
        }
        return {stat_id: element.stat_id, route_id: element.route_id, time: dayjs(transport_base_date.format('YYYY-MM-DD')+element.time,'YYYY-MM-DDHHmmss')}
      })

      const final_term_result = {}
      term_result.forEach((element) => {
        if(element.term !== null && element.term !== undefined){
          final_term_result[element.route_id] = element.term
        } else {
          final_term_result[element.route_id] = null
        }
      })
      
      const final_time_result = {}
      bus_time_result.forEach((element)=>{
        if(element.time !== null && element.time !== undefined && final_term_result[element.route_id] !== undefined && final_term_result[element.route_id] !== null){
          final_time_result[String(element.stat_id)+'-'+String(element.route_id)] = {stat_id: element.stat_id, route_id: element.route_id, term: final_term_result[element.route_id], time: element.time}
        } else {
          final_time_result[element.route_id] = null
        }
      })

      return final_time_result
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
  
  let day_type = date.day() === 0 ? 'holiday' : date.day() === 6 ? 'sat' : 'day'
  const solar_holiday = ['0101', '0301', '0505','0606','0815','1003','1009','1225']
  const lunar_holiday = ['0527','0928','0929','0930']

  if(solar_holiday.includes(date.format('MMDD')) || lunar_holiday.includes(date.format('MMDD'))){
    day_type = 'holiday'
  }

  return [day_type, date]
}

module.exports = {pathRouter}