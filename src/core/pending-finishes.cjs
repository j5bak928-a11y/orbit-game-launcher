'use strict';

// Keep a completed game's final duration until SQLite accepts it. Failed
// writes are retried without adding another playtime session or re-measuring
// the duration after the game has exited.
function pendingFinishes({finish,onSuccess=()=>{},onError=()=>{}}){
 const pending=new Map();
 function flush(){
  for(const [id,entry] of pending){
   try{
    finish(entry.sessionId,entry.seconds);
    pending.delete(id); // false means another caller already committed it.
    try{onSuccess(id);}catch{}
   }catch(error){try{onError(id,error);}catch{}}
  }
 }
 return {
  has:id=>pending.has(id),
  add(id,sessionId,seconds){
   if(pending.has(id))return false;
   pending.set(id,{sessionId,seconds});flush();return true;
  },
  flush,
  size:()=>pending.size,
 };
}
module.exports={pendingFinishes};
