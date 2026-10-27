'use strict';
// Share small lookup results and cached filenames, never image byte buffers.
// The same pool bounds work from imports, startup repair and manual requests.
const CANCELLED=Symbol('artwork-cancelled');
class ArtworkWork {
  constructor({concurrency=3,maxEntries=512,successTtl=60*60*1000,missTtl=10*60*1000,clock=Date.now}={}) {
    this.concurrency=Math.max(1,Math.floor(concurrency));
    this.maxEntries=Math.max(1,Math.floor(maxEntries));
    this.successTtl=successTtl;this.missTtl=missTtl;this.clock=clock;
    this.active=0;this.queue=[];this.pending=new Map();this.cache=new Map();
  }
  run(key,operation,{isRelevant=()=>true}={}) {
    const cached=this.cache.get(key);
    if(cached&&cached.until>this.clock())return Promise.resolve(cached.value);
    if(cached)this.cache.delete(key);
    const pending=this.pending.get(key);
    if(pending){pending.interests.push(isRelevant);return pending.promise;}
    let job;
    const promise=new Promise((resolve,reject)=>{
      job={key,operation,resolve,reject,interests:[isRelevant]};this.queue.push(job);
    });
    job.promise=promise;this.pending.set(key,job);this.pump();return promise;
  }
  pump() {
    while(this.active<this.concurrency&&this.queue.length) {
      const job=this.queue.shift();this.active++;
      const needed=()=>job.interests.some(check=>{try{return !!check();}catch{return false;}});
      let subscribersAtStart=0;
      Promise.resolve().then(()=>{
        subscribersAtStart=job.interests.length;
        return needed()?job.operation(needed):CANCELLED;
      }).then(value=>{
        // A new subscriber may arrive after an obsolete operation completes.
        if(value===CANCELLED&&job.interests.length>subscribersAtStart&&needed()){
          this.active--;this.queue.push(job);this.pump();return;
        }
        if(value!==CANCELLED){
          const ttl=value?this.successTtl:this.missTtl;
          this.cache.set(job.key,{value,until:this.clock()+ttl});
          while(this.cache.size>this.maxEntries)this.cache.delete(this.cache.keys().next().value);
        }
        this.pending.delete(job.key);this.active--;this.pump();job.resolve(value===CANCELLED?'':value);
      },error=>{this.pending.delete(job.key);this.active--;this.pump();job.reject(error);});
    }
  }
  clearMisses() {for(const [key,entry] of this.cache)if(!entry.value)this.cache.delete(key);}
  clear() {this.cache.clear();}
}
ArtworkWork.CANCELLED=CANCELLED;
module.exports={ArtworkWork};
