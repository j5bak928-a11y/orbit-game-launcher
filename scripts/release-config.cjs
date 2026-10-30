'use strict';
function validateReleaseConfig(pkg,lock){
 const issues=[];
 const version=String(pkg.version||'');
 const display=version.replace(/\+(\d+)$/,'.$1');
 if(lock.version!==version||lock.packages?.['']?.version!==version)issues.push('lockfile version must match package version');
 if(pkg.name!=='orbit-game-launcher')issues.push('package name must remain stable for the data directory');
 if(pkg.build?.productName!=='Orbit Launcher')issues.push('productName must remain stable for upgrades');
 if(pkg.build?.nsis?.perMachine===true)issues.push('perMachine must not change the existing install scope');
 if(pkg.build?.appId!=='com.orbitlauncher.desktop')issues.push('appId must remain stable for upgrades');
 if(pkg.build?.nsis?.deleteAppDataOnUninstall===true)issues.push('deleteAppDataOnUninstall must not be enabled');
 if(pkg.build?.buildVersion!==display)issues.push('buildVersion must match displayed release version');
 if(pkg.build?.nsis?.artifactName!==`Orbit-Launcher-Setup-${display}.\${ext}`)issues.push('installer artifactName must match release version');
 if(pkg.build?.portable?.artifactName!==`Orbit-Launcher-${display}.\${ext}`)issues.push('portable artifactName must match release version');
 return issues;
}
module.exports={validateReleaseConfig};
