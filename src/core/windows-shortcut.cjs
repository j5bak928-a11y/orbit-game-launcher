'use strict';
const fs=require('node:fs');
const path=require('node:path');
function resolveWindowsShortcut(file,readShortcut){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.extname(file).toLowerCase()!=='.lnk')throw Error('Choose an absolute Windows shortcut path.');
 let stat;try{stat=fs.statSync(file);}catch{throw Error('The shortcut was not found.');}
 if(!stat.isFile())throw Error('The shortcut was not found.');
 let link;try{link=readShortcut(file);}catch{throw Error('Windows could not read this shortcut.');}
 if(typeof link?.args==='string'&&link.args.trim())throw Error('Shortcuts with arguments are not supported. Choose the game executable instead.');
 const target=link?.target;
 if(typeof target!=='string'||!path.isAbsolute(target)||!/[.](exe|com)$/i.test(target))throw Error('The shortcut target must be a Windows executable.');
 const cwd=link.cwd||path.dirname(target);
 if(!path.isAbsolute(cwd))throw Error('The shortcut working directory is invalid.');
 return {executable:path.normalize(target),working_dir:path.normalize(cwd)};
}
module.exports={resolveWindowsShortcut};
