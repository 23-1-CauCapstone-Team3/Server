const express = require('express')
const app = express()

require("dotenv").config();

const {pathRouter} = require('./routes/pathRouter')

const port = 3000

const server = async () => {
  try{
    app.use(express.json())
    app.use(express.urlencoded({extended: true}))
    
    app.use('/route', pathRouter)

    app.listen(port, () => {
      console.log(`App listening on port ${port}`)
    })
  } catch(error){
      console.log(error)
  }
}

server()