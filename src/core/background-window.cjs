'use strict';
function backgroundWindow({close,show}){
 let quitting=false;
 return {onClose(event,available){if(!quitting&&available){event.preventDefault();close();}},open(){show();},quit(){quitting=true;}};
}
module.exports={backgroundWindow};
