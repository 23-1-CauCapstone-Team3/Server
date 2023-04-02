const { Router } = require('express')
const axios = require('axios')
require("dotenv").config();

pathRouter = Router()

const SK_API_KEY = process.env.SK_API_KEY

pathRouter.post('/', async(req, res) => {
  try{

    const options = {
      method: 'POST',
      url: 'https://apis.openapi.sk.com/transit/routes',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        appKey: SK_API_KEY
      },
      data: {
        startX: '126.926493082645',
        startY: '37.6134436427887',
        endX: '127.126936754911',
        endY: '37.5004198786564',
        lang: 0,
        format: 'json',
        count: 10,
        searchDttm: "202301012300"
      }
    };
    
    const result = await axios.request(options)

    return res.status(200).json(result.data.metaData)

  } catch (err) {
    console.log(err)
    return res.status(400).send({ error: err.message, result: false}) 
  }

})

module.exports = {pathRouter}