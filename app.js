const express = require('express')
const app = express()

require("dotenv").config();

const port = 3000

const server = async () => {
  try{
      app.get('/', (req, res)=> {
          res.send('server test')
      })

      app.listen(port, () => {
          console.log(`App listening on port ${port}`)
      })
  } catch(error){
      console.log(error)
  }
}

server()