'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {jpegDimensions,imageDimensions,isPortraitArtwork}=require('../src/core/cover-shape.cjs');

function jpeg(width,height){
 const b=Buffer.from([255,216,255,192,0,11,8,0,0,0,0,1,1,17,0,255,217]);
 b.writeUInt16BE(height,7);b.writeUInt16BE(width,9);return b;
}
function png(width,height){
 const b=Buffer.alloc(24);
 Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);
 b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;
}
function webp(width,height){
 const b=Buffer.alloc(30);b.write('RIFF',0);b.write('WEBP',8);b.write('VP8X',12);
 b.writeUIntLE(width-1,24,3);b.writeUIntLE(height-1,27,3);return b;
}
test('portrait JPEG art is accepted; wide Steam banners are rejected',()=>{
 const poster=jpeg(600,900),header=jpeg(616,353);
 assert.deepEqual(jpegDimensions(poster),{width:600,height:900});
 assert.deepEqual(jpegDimensions(header),{width:616,height:353});
 assert.equal(isPortraitArtwork(poster),true);
 assert.equal(isPortraitArtwork(header),false);
 assert.equal(isPortraitArtwork(jpeg(300,300)),false);
});
test('JPEG marker parsing is bounded and malformed metadata is rejected',()=>{
 assert.equal(imageDimensions(Buffer.from([255,216,255,192,0,100,8])),null);
 assert.equal(imageDimensions(Buffer.from([255,216,255,217])),null);
 assert.equal(isPortraitArtwork(Buffer.from([255,216,255,0,14,34,9])),false);
});
test('existing user-added PNG and WebP portraits are recognized for repair safety',()=>{
 assert.deepEqual(imageDimensions(png(300,450)),{width:300,height:450});
 assert.equal(isPortraitArtwork(png(300,450)),true);
 assert.equal(isPortraitArtwork(png(800,450)),false);
 assert.deepEqual(imageDimensions(webp(600,900)),{width:600,height:900});
 assert.equal(isPortraitArtwork(webp(600,900)),true);
 assert.equal(isPortraitArtwork(webp(1024,576)),false);
});
