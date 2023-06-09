const axios = require('axios')
const dayjs = require("dayjs")
const isSameOrBefore = require("dayjs/plugin/isSameOrBefore")
const isSameOrAfter = require('dayjs/plugin/isSameOrAfter')

dayjs.extend(isSameOrAfter)
dayjs.extend(isSameOrBefore)

require("dotenv").config();

const mysql = require('../mysql/mysql')  // mysql 모듈 로드

const SK_API_KEY = process.env.SK_API_KEY
const ODSAY_API_KEY = process.env.ODSAY_API_KEY

const findPath = async(req, res) => {
  try{

    const time = req.query.time
    const startX = req.query.startX
    const startY = req.query.startY
    const endX = req.query.endX
    const endY = req.query.endY


      if(!time ||!startX || !startY || !endX || !endY){
        return res.status(400).send({ error: 'Request parameters are incorrect', result: false })
      }
    
    const userTime = dayjs(time);
  
    const [dayType, transport_base_date] = await checkDateType()
    const dayCode = dayType === 'day'? 1 : dayType === 'sat' ? 2 : 3

    /**
     * 버스, 도보 여유 시간
     */
    const bus_alpha = 3
    const walk_alpha = 3


    const routeResult = await axios.get(`https://api.odsay.com/v1/api/searchPubTransPathT?SX=${startX}`+
                                        `&SY=${startY}&EX=${endX}&EY=${endY}&apiKey=${ODSAY_API_KEY}`);

    // 최근 수정라인                                    
    if(routeResult.data.result.path === undefined){
      return res.status(400).send({ error: 'odsay API error', result: false })
    }


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
            startLocalStationID: subElement.startLocalStationID,
            endArsID: subElement.endArsID, 
            endLocalStationID: subElement.endLocalStationID}
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
      .map((element)=>{return element.lane.map((lanes)=>{ return {busLocalBlID: lanes, startLocalStationID: element.startLocalStationID, endLocalStationID: element.endLocalStationID} })})
      .flat()
      .reduce((accumulator, current) => {
        const sameRes = accumulator.find(element => element.busLocalBlID === current.busLocalBlID && 
          element.startLocalStationID === current.startLocalStationID && element.endLocalStationID === current.endLocalStationID)
        if (sameRes) {
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
        const sameRes = accumulator.find(element => element.subwayCode === current.subwayCode && element.wayCode === current.wayCode 
                                    && element.startID === current.startID && element.endID === current.endID && element.subwayName === current.subwayName)
        if (sameRes) {
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

      let subLastPathTime = 24*60*2
      
      const subPathLength = path.length - 1

      /**
       * 각 서브 경로에 대해 막차 시간을 계산하는 구간
       * 역순으로 계산 실시
       * 3번 도보, 2번 버스, 1번 지하철
      */

      for(let i = subPathLength; i >= 0; i--){
  
        if(subLastPathTime !== null){

          if(path[i].trafficType === 3){

            if(path[i].sectionTime == 0 && i !== subLastPathTime && i !== 0){
              if(path[i-1].trafficType !== 2 || path[i+1].trafficType !== 2){
                path[i].sectionTime = 6
                subLastPathTime = subLastPathTime - (path[i].sectionTime + walk_alpha)
              } else {
                subLastPathTime = subLastPathTime - (path[i].sectionTime+walk_alpha)
              }
            } else{
              subLastPathTime = subLastPathTime - (path[i].sectionTime+walk_alpha)
            }
          } else if(path[i].trafficType === 2) {

            // 여러 버스 노선들을 각각에 맞는 정보로 바꿔주는 작업
            const busLaneList = path[i].lane.map((element)=>{
              
              const stringKey = String(element.busLocalBlID)+'-'+String(path[i].startLocalStationID)+'-'+String(path[i].endLocalStationID)
              
              if(bus_term_time[stringKey] !== undefined && bus_term_time[stringKey] !== null){
                return bus_term_time[stringKey]
              } else {
                return null
              }
            })

            // 변환한 정보들 중 디비에 없는 데이터들로만 구성된 경우 계산 불가임. 그래서 바로 null 반환 
            if(busLaneList.filter(element => element).length < 1){
              subLastPathTime = null
              break
            }

            // 변환한 정보 중 가장 늦은 막차시간을 가진 버스 정보를 고르는 과정
            const bus_data = busLaneList.filter(element => element).reduce((prev, now) => {
              if(prev.time >= now.time) {
                return prev
              } else {
                return now
              }
            })
            
            const busLastTime = bus_data.time

            // 배차간격을 계속 빼서 가장 근접한 버스 출발 시간을 정함 최신 수정
            
            let busStartTime = busLastTime
            const minimumStartTime = subLastPathTime - path[i].sectionTime

            while(minimumStartTime < busStartTime){
              busStartTime -= bus_data.term
            }

            subLastPathTime = busStartTime - bus_alpha

            // 마지막에 선택된 노선의 정보들을 저장해줌 
            path[i].busTerm = bus_data.term
            path[i].lane = path[i].lane.filter(element => element.busLocalBlID === String(bus_data.route_id))
            path[i].lane.departureTime = getDateValue(transport_base_date, subLastPathTime).format('YYYY-MM-DDTHH:mm:ss')

          } else {
            const numberLine = [1, 2, 3, 4, 5, 6, 7, 8, 9]

            const lanesWithTime = path[i].lane.map((lane)=>{
              let rail_type= 0
              if(lane.name.includes('급행') || lane.name.includes('특급')){
                rail_type= 1
              }

              let DC = dayCode
              if (dayCode === 3 && !numberLine.includes(lane.subwayCode)){
                DC = 2
              }

              const keyString = String(lane.subwayCode)+'-'+String(path[i].wayCode)+'-'+String(DC)+'-'
              +String(rail_type)+'-'+String(path[i].startID)+'-'+String(path[i].endID)

              if (train_time[keyString] === undefined || train_time[keyString] === null) {
                return null
              }

              const endStationRail = train_time[keyString][path[i].endID].filter((element)=>{

                if (element.time < subLastPathTime){
                  return true
                } else {
                  return false
                }
              })

              if(endStationRail.length === 0){
                return null
              }

              const endStationLastRail = endStationRail.reduce((prev, now)=>{
                if(prev.time > now.time){
                  return prev
                } else { 
                  return now
                }
              })

              const startStationLastRail = train_time[keyString][path[i].startID].filter((element)=> {
              
                if(element.train_id === endStationLastRail.train_id && element.time < endStationLastRail.time) {
                  return true
                } else{
                  return false
                }
              })

              if(startStationLastRail.length === 0){
                return null
              }
                  
              const newLastPathTime = startStationLastRail.reduce((prev, now) => { 
                if(prev.time > now.time) {
                  return prev
                } else {
                  return now
                }
              })
              return {newLastPathTime:newLastPathTime, endStationLastRail:endStationLastRail}
            })

            const nonNullLanes = lanesWithTime.filter((element)=>element)

            if(nonNullLanes.length === 0){
              subLastPathTime = null
              break
            }

            const lastTrainTimeInfo = nonNullLanes.reduce((prev,now)=>{
              if(prev.newLastPathTime.time >= now.newLastPathTime.time){
                return prev
              } else {
                return now
              }
            })
            
            subLastPathTime = lastTrainTimeInfo.newLastPathTime.time
            path[i].lane[0].departureTime = getDateValue(transport_base_date, subLastPathTime).format('YYYY-MM-DDTHH:mm:ss')
            path[i].lane[0].arrivalTime = getDateValue(transport_base_date, lastTrainTimeInfo.endStationLastRail.time).format('YYYY-MM-DDTHH:mm:ss')
              
          }
        }
      }
      
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
      const pathTime = getDateValue(transport_base_date,element.subLastPathTime)
      
      if(pathTime.isAfter(userTime)){
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
        
      if(prev.subLastPathTime >= now.subLastPathTime) {
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

        arrivalTime = arrivalTime + (path.sectionTime + walk_alpha)

      } else if(path.trafficType === 2) {

        path.lane[0].departureTime = getDateValue(transport_base_date, arrivalTime).format('YYYY-MM-DDTHH:mm:ss')
        const term = bus_term_time[path.lane[0].busLocalBlID+'-'+path.startLocalStationID+'-'+path.endLocalStationID].term

        // 배차간격과 알파값 안더함 최신 수정
        arrivalTime = arrivalTime+ (path.sectionTime )

        //arrivalTime = arrivalTime+ (path.sectionTime+term+ bus_alpha)
          
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
          if(arrivalTime <= element.time){
            return true
          } else {
            return false
          }
        })

        for (let i =0; i < startTimeInfo.length;i++){
          const endWithSameTrain = train_time[keyString][path.endID].filter((element)=>{
            if(element.time > startTimeInfo[i].time && element.train_id === startTimeInfo[i].train_id){
              return true
            } else {
              return false
            }
          })

          if(endWithSameTrain.length !== 0){
            const endTimeInfo = endWithSameTrain.reduce((prev, now)=>{
              if(prev.time <= now.time) {
                return prev
              } else {
                return now
              }
            })

            path.lane[0].arrivalTime = getDateValue(transport_base_date,endTimeInfo.time).format('YYYY-MM-DDTHH:mm:ss')
            path.lane[0].departureTime = getDateValue(transport_base_date,startTimeInfo[i].time).format('YYYY-MM-DDTHH:mm:ss')
            arrivalTime = endTimeInfo.time
            break
          }
          
        }  
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
        
        element.steps = walkRoute.data.features
        
      }
      return element
    }))
    
    return res.status(200).send({
      pathExistence: true,
      arrivalTime: getDateValue(transport_base_date, arrivalTime).format('YYYY-MM-DDTHH:mm:ss'),
      departureTime: getDateValue(transport_base_date, lastPath.subLastPathTime).format('YYYY-MM-DDTHH:mm:ss'), 
      pathInfo: {pathType:lastPath.pathType, info:lastPath.info, subPath: lastPath.path}})

  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false }) 
  }

}

function getDateValue(date, time){
  return dayjs(date.format('YYYYMMDD') + String(parseInt(time/60)).padStart(2, '0') + String(time%60).padStart(2, '0'),'YYYYMMDDhhmm')
}

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

        // 검색되는 것이 없다면 null 반환
        if(stationTimeList.length <= 0){
          return {stringKey: String(subwayCode)+'-'+String(wayCode)+'-'+String(DC)+'-'+String(rail_type)+'-'+String(startID)+'-'+String(endID), time: null} 
        }  
        
        // 역코드를 이용하여 출발역 시간과 도착역 시간 분리
        const result = stationTimeList.reduce((accumulator, obj) => {
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

      const busTimeList = await Promise.all(totalInfo.map(async (element) => {

        const termSQL = `SELECT route_id , ${dayType} as term FROM bus_term WHERE route_id = ${element.busLocalBlID};`
        const term_result = await selectDataWithQuery(termSQL)

        if(term_result === undefined || term_result === null || term_result.length === 0){
          return {start_id: element.startLocalStationID, end_id :element.endLocalStationID, route_id: element.busLocalBlID, term: null, time: null}
        }
        if(term_result[0].term === -1 || term_result[0].term === null || term_result[0].term === undefined){
          return {start_id: element.startLocalStationID, end_id :element.endLocalStationID, route_id: element.busLocalBlID, term: null, time: null}
        }

        const busTimeSQL = `SELECT * FROM bus_last_time WHERE route_id = ${element.busLocalBlID} `+
                            `AND (stat_id =${element.startLocalStationID} OR stat_id =${element.endLocalStationID})`
        let bus_time_result = await selectDataWithQuery(busTimeSQL)

        if(bus_time_result === undefined || bus_time_result === null || bus_time_result.length === 0){
          return {start_id: element.startLocalStationID, end_id:element.endLocalStationID, route_id: element.busLocalBlID, term: null, time: null}
        }

        // bus 정보 order값으로 정렬
        bus_time_result.sort((a, b)=>{
          return a.order - b.order
        })

        let startBusInfo = null
        for ( let i = 0; i < bus_time_result.length - 1; i++){
          if (String(bus_time_result[i].stat_id) === element.startLocalStationID && String(bus_time_result[i+1].stat_id) === element.endLocalStationID){
            startBusInfo = bus_time_result[i]
          }
        }

        if(startBusInfo === null){
          return {start_id: element.startLocalStationID, end_id:element.endLocalStationID, route_id: element.busLocalBlID, term: null, time: null}
        }

        return {start_id: element.startLocalStationID, end_id:element.endLocalStationID, route_id: element.busLocalBlID, term: term_result[0].term, time: startBusInfo.time}
      }))

      const final_time_result = {}
      busTimeList.forEach((element)=>{
          if(element.term !== null || element.time !== null){
            final_time_result[String(element.route_id)+'-'+String(element.start_id)+'-'+String(element.end_id)] = element
          } else {
            final_time_result[String(element.route_id)+'-'+String(element.start_id)+'-'+String(element.end_id)] = null
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


async function checkDateType(){
  
  const transportDate = await selectDataWithQuery('select * from now_date')
  const holidayList = await selectDataWithQuery('select * from holiday')
  
  const date = dayjs(transportDate[0].date,'YYYYMMDD')

  let day_type = date.day() === 0 ? 'holiday' : date.day() === 6 ? 'sat' : 'day'
  
  const hoildayCheck = holidayList.filter((element)=>{element.date === date.format('YYYYMMDD')})

  if(hoildayCheck.length > 0){
    day_type = 'holiday'
  }

  return [day_type, date]
}

module.exports = {
  findPath,
}