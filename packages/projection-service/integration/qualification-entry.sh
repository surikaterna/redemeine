#!/bin/sh
set -eu
# Qualification-only relay keeps the audited service's HTTP endpoint explicitly loopback.
socat TCP4-LISTEN:15672,bind=127.0.0.1,reuseaddr,fork,max-children=8 TCP4:rabbit:15672 &
node --input-type=module -e '
import {connect} from "node:net";
const end=performance.now()+3000;
while(true){
  const ready=await new Promise(resolve=>{const socket=connect({host:"127.0.0.1",port:15672});socket.once("connect",()=>{socket.destroy();resolve(true)});socket.once("error",()=>resolve(false));});
  if(ready)break;
  if(performance.now()>=end)process.exit(1);
  await new Promise(resolve=>setTimeout(resolve,20));
}'
# Relay starts before Node opens the writer-lock FD, so it cannot inherit that descriptor.
exec node /app/main.js
