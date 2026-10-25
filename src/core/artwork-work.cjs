'use strict';
// Share small lookup results and cached filenames, never image byte buffers.
// The same pool bounds work from imports, startup repair and manual requests.
class ArtworkWork {
  constructor({concurrency=3,maxEntries=512,successTtl=60*60*1000,missTtl=10*60*1000,clock=Date.now}={}) {
    this.concurrency=Math.max(1,Math.floor(concurrency));
    this.maxEntries=Math.max(1,Math.floor(maxEntries));
    this.successTtl=successTtl;this.missTtl=missTtl;this.clock=clock;
    this.active=0;this.queue=[];this.pending=new Map();this.cache=new Map();
  }
  run(key,operation) {
    const cached=this.cache.get(key);
    if(cached&&cached.until>this.clock())return Promise.resolve(cached.value);
    if(cached)this.cache.delete(key);
    if(this.pending.has(key))return this.pending.get(key);
    const promise=new Promise((resolve,reject)=>{this.queue.push({key,operation,resolve,reject});});
    this.pending.set(key,promise);this.pump();return promise;
  }
  pump() {
    while(this.active<this.concurrency&&this.queue.length) {
      const job=this.queue.shift();this.active++;
      Promise.resolve().then(job.operation).then(value=>{
        const ttl=value?this.successTtl:this.missTtl;
        this.cache.set(job.key,{value,until:this.clock()+ttl});
        while(this.cache.size>this.maxEntries)this.cache.delete(this.cache.keys().next().value);
        this.pending.delete(job.key);this.active--;this.pump();job.resolve(value);
      },error=>{this.pending.delete(job.key);this.active--;this.pump();job.reject(error);});
    }
  }
  clearMisses() {for(const [key,entry] of this.cache)if(!entry.value)this.cache.delete(key);}
  clear() {this.cache.clear();}
}
module.exports={ArtworkWork};
