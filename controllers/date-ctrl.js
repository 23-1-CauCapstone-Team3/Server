const schedule = require("node-schedule");
const mysql = require('../mysql/mysql') 
const axios = require('axios')
const dayjs = require("dayjs")

require("dotenv").config();

const API_KEY = process.env.BUS_STATION_API_KEY
const saveDate = async () => {
  console.log('date 스케쥴 시작')
  const nowTime = dayjs()

  if(parseInt(nowTime.get("h")) >= 9 && parseInt(nowTime.get("h")) < 21){
    await setHoliday()
    await setNowTime()
  }

  schedule.scheduleJob('job_holiday','0 0 9 * * *', setHoliday)
  schedule.scheduleJob('job_10','0 0 9 * * *', setNowTime)
  schedule.scheduleJob('job_15','0 0 14 * * *', setNowTime)
  schedule.scheduleJob('job_20','0 0 19 * * *', setNowTime)
}

async function setNowTime(){
  const nowTime = dayjs()
  const conn = await mysql.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('delete from now_date;')
    await conn.query('insert into now_date values (?);', nowTime.format('YYYYMMDD'))
    await conn.commit()
  } catch (err) {
    console.log(err)
    await conn.rollback()
  } finally {
    conn.release()
  }
}

async function setHoliday(){
  const now = dayjs()
  const nextMonth = now.add(1, 'month')
  
  const holidayListResult1= await getHolidayWithAPI(now)
  const holidayListResult2 = await getHolidayWithAPI(nextMonth)

  const holidayList = holidayListResult1.concat(holidayListResult2)
  const conn = await mysql.getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('delete from holiday;')
    if(holidayList.length > 0){
      await conn.query('insert into holiday values ?;', [holidayList])
    }
    await conn.commit()
  } catch (err) {
    console.log(err)
    await conn.rollback()
  } finally {
    conn.release()
  }
}

async function getHolidayWithAPI(nowTime){
  const holidayList = []

  const holidayResult = await axios.get('http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo?'+
  `solYear=${nowTime.format('YYYY')}&solMonth=${nowTime.format('MM')}&ServiceKey=${API_KEY}&numOfRows=20&_type=json`);
  if(holidayResult.data.response === undefined){
    return []
  }

  if(holidayResult.data.response.body.items.item !== undefined){
    if(Array.isArray(holidayResult.data.response.body.items.item)){
      holidayResult.data.response.body.items.item.forEach((element)=>{
        holidayList.push([element.locdate])
      })
    } else{
      holidayList.push([holidayResult.data.response.body.items.item.locdate])
    }
  }
  return holidayList
}

module.exports = {
  saveDate,
};