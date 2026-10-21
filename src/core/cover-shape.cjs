'use strict';
// Read image dimensions without decoding pixels or running external programs.
// Bounds and marker checks also protect the artwork selector from malformed files.
function jpegDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length<4 || bytes[0]!==0xff || bytes[1]!==0xd8) return null;
  let at=2;
  while(at+3<bytes.length) {
    if(bytes[at++]!==0xff) return null;
    while(at<bytes.length && bytes[at]===0xff)at++;
    if(at>=bytes.length)return null;
    const marker=bytes[at++];
    if(marker===0xd9||marker===0xda)break;
    if(marker===0xd8||marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
    if(at+2>bytes.length)return null;
    const len=bytes.readUInt16BE(at);
    if(len<2||at+len>bytes.length)return null;
    if(([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]).includes(marker)) {
      if(len<7)return null;
      const height=bytes.readUInt16BE(at+3),width=bytes.readUInt16BE(at+5);
      return width>0&&height>0?{width,height}:null;
    }
    at+=len;
  }
  return null;
}
function imageDimensions(bytes) {
  if(!Buffer.isBuffer(bytes))return null;
  if(bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    return width>0&&height>0&&width<100000&&height<100000?{width,height}:null;
  }
  if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP') {
    const type=bytes.toString('ascii',12,16);
    if(type==='VP8X'){
      const width=1+bytes.readUIntLE(24,3),height=1+bytes.readUIntLE(27,3);
      return {width,height};
    }
    if(type==='VP8 '&&bytes.length>=30&&bytes[23]===0x9d&&bytes[24]===0x01&&bytes[25]===0x2a)
      return {width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
    if(type==='VP8L'&&bytes.length>=25&&bytes[20]===0x2f){
      const width=1+(((bytes[22]&0x3f)<<8)|bytes[21]);
      const height=1+(((bytes[24]&0x0f)<<10)|(bytes[23]<<2)|((bytes[22]&0xc0)>>6));
      return {width,height};
    }
    return null;
  }
  return jpegDimensions(bytes);
}
function isPortraitArtwork(bytes) {
  const dims=imageDimensions(bytes);
  if(!dims)return false;
  const aspect=dims.width/dims.height;
  return dims.width>=80&&dims.height>=120&&aspect>=0.5&&aspect<=0.85;
}
module.exports={jpegDimensions,imageDimensions,isPortraitArtwork};
