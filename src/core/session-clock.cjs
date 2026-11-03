'use strict';
const {performance}=require('node:perf_hooks');
// Count awake, running time only; wall-clock sleep is not play time.
function sessionClock(now=()=>performance.now()){
 const started=now();let pausedAt=null,pausedTotal=0;
 return {
  pause(){if(pausedAt===null)pausedAt=now();},
  resume(){if(pausedAt!==null){pausedTotal+=Math.max(0,now()-pausedAt);pausedAt=null;}},
  seconds(){return Math.max(0,Math.floor(((pausedAt??now())-started-pausedTotal)/1000));}
 };
}
module.exports={sessionClock};
