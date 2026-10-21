'use strict';
// Conservative offline title aliases for standalone games. Never infer an
// install source, a license, or a launch URI from a filename. An optional Steam
// app ID is used only to request publicly available artwork.
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const execFileAsync = promisify(execFile);

const CATALOG = [
  {name:'Hearts of Iron IV',steamId:'394360',aliases:['hoi4','heartsofiron4','heartsofironiv']},
  {name:'Europa Universalis IV',steamId:'236850',aliases:['eu4','europauniversalis4','europauniversalisiv']},
  {name:'Crusader Kings III',steamId:'1151640',aliases:['ck3','crusaderkings3','crusaderkingsiii']},
  {name:'Crusader Kings II',steamId:'203770',aliases:['ck2','crusaderkings2','crusaderkingsii']},
  {name:'Victoria 3',steamId:'529340',aliases:['vic3','victoria3','vicky3']},
  {name:'Stellaris',steamId:'281990',aliases:['stellaris']},
  {name:'Cities: Skylines',steamId:'255710',aliases:['citiesskylines','cities1']},
  {name:'Cities: Skylines II',steamId:'949230',aliases:['citiesskylines2','cities2']},
  {name:'Grand Theft Auto V',steamId:'271590',aliases:['gta5','gtav','grandtheftauto5','grandtheftautov']},
  {name:'Red Dead Redemption 2',steamId:'1174180',aliases:['rdr2','reddeadredemption2']},
  {name:'Cyberpunk 2077',steamId:'1091500',aliases:['cyberpunk2077']},
  {name:'The Witcher 3: Wild Hunt',steamId:'292030',aliases:['witcher3','thewitcher3','witcher3wildhunt','witcher3wildhunt']},
  {name:'Baldur’s Gate 3',steamId:'1086940',aliases:['bg3','baldursgate3']},
  {name:'Elden Ring',steamId:'1245620',aliases:['eldenring']},
  {name:'Hollow Knight',steamId:'367520',aliases:['hollowknight']},
  {name:'Hollow Knight: Silksong',steamId:'1030300',aliases:['silksong','hollowknightsilksong']},
  {name:'RimWorld',steamId:'294100',aliases:['rimworld','rimworldwin64']},
  {name:'Factorio',steamId:'427520',aliases:['factorio']},
  {name:'Terraria',steamId:'105600',aliases:['terraria']},
  {name:'Stardew Valley',steamId:'413150',aliases:['stardewvalley']},
  {name:'Valheim',steamId:'892970',aliases:['valheim']},
  {name:'Project Zomboid',steamId:'108600',aliases:['projectzomboid','zomboid64','zomboid']},
  {name:'Mount & Blade II: Bannerlord',steamId:'261550',aliases:['bannerlord','mountblade2bannerlord']},
  {name:'The Sims 4',steamId:'1222670',aliases:['ts4','thesims4']},
  {name:'Counter-Strike 2',steamId:'730',aliases:['cs2','counterstrike2']},
  {name:'Dota 2',steamId:'570',aliases:['dota2']},
  {name:'Kingdom Come: Deliverance',steamId:'379430',aliases:['kingdomcome','kingdomcomedeliverance']},
];
const cleanKey = text => String(text || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const byAlias = new Map();
for(const entry of CATALOG){
  for(const alias of [...entry.aliases,entry.name]){
    const key=cleanKey(alias);
    if(byAlias.has(key)&&byAlias.get(key)!==entry)throw Error('Duplicate game title alias: '+key);
    byAlias.set(key,entry);
  }
}
const GENERIC = /^(?:game|gamewin(?:32|64)shipping|launcher|launch|play|start|run|shipping|win64shipping|application|program|unreal|unity|unityplayer|binaries|win32|win64|x64|bin|release|retail|main|bootstrapper|project)$/i;
const suffix = /(?:win64shipping|win32shipping|win64|win32|shipping|64bit|x64)$/i;
function catalogMatch(candidate){
  if(!candidate)return null;
  const key=cleanKey(candidate);
  return byAlias.get(key) || byAlias.get(key.replace(suffix,'')) || null;
}
function folderCandidates(file){
  const results=[];
  let dir=path.dirname(file);
  for(let depth=0;depth<3;depth++){
    const name=path.basename(dir);
    if(!name||name===path.parse(dir).root)break;
    if(!GENERIC.test(cleanKey(name)))results.push(name);
    dir=path.dirname(dir);
  }
  return results;
}
function sensibleProductName(value){
  if(typeof value!=='string')return '';
  const name=value.replace(/[\u0000-\u001f]+/g,' ').replace(/\s+/g,' ').trim();
  if(name.length<3||name.length>140||!/[a-z]{3}/i.test(name)||GENERIC.test(cleanKey(name)))return '';
  if(/^(?:microsoft|windows|unity|unreal engine|electron|game engine|product name|unknown)(?:\s|$)/i.test(name))return '';
  return name;
}
function identifyGame(file,{productName='',fallbackName=''}={}){
  const stem=path.basename(file,path.extname(file));
  const direct=catalogMatch(stem);
  if(direct)return {name:direct.name,steamId:direct.steamId,kind:'executable'};
  const metadata=sensibleProductName(productName);
  const fromMetadata=catalogMatch(metadata);
  if(fromMetadata)return {name:fromMetadata.name,steamId:fromMetadata.steamId,kind:'metadata'};
  for(const folder of folderCandidates(file)){
    const found=catalogMatch(folder);
    if(found)return {name:found.name,steamId:found.steamId,kind:'folder'};
  }
  if(metadata)return {name:metadata,steamId:'',kind:'metadata'};
  return {name:fallbackName||stem||'Untitled game',steamId:'',kind:'filename'};
}
// GetVersionInfo reads PE VERSIONINFO resources. It never runs the selected
// executable. The path is encoded before being embedded into the static script
// and execFile invokes PowerShell without invoking an OS command shell.
async function readWindowsProductName(file,{platform=process.platform,run=execFileAsync}={}){
  if(platform!=='win32'||path.extname(file).toLowerCase()!=='.exe')return '';
  const encodedFile=Buffer.from(file,'utf16le').toString('base64');
  const script=`$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedFile}'));$i=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);[Console]::Out.Write($i.ProductName)`;
  try{
    const {stdout}=await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:2500,maxBuffer:4096,windowsHide:true});
    return sensibleProductName(stdout);
  }catch{return ''}
}
module.exports={CATALOG,cleanKey,catalogMatch,identifyGame,readWindowsProductName,sensibleProductName};
