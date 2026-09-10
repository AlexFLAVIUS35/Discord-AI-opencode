type PersonalitySplitSession = {
  botId: string;
  scopeId: string;
  userId: string;
  scopeType: 'personal' | 'guild';
  parts: string[];
  createdAt: number;
};

const sessions = new Map<string, PersonalitySplitSession>();
const SESSION_TTL_MS = 15 * 60 * 1000;
function key(botId:string,scopeId:string,userId:string):string{return `${botId}:${scopeId}:${userId}`;}
function getValidSession(botId:string,scopeId:string,userId:string):PersonalitySplitSession|undefined{const k=key(botId,scopeId,userId);const session=sessions.get(k);if(!session)return undefined;if(Date.now()-session.createdAt>SESSION_TTL_MS){sessions.delete(k);return undefined;}return session;}
export function start(botId:string,scopeId:string,userId:string,scopeType:'personal'|'guild'='personal'):void{sessions.set(key(botId,scopeId,userId),{botId,scopeId,userId,scopeType,parts:[],createdAt:Date.now()});}
export function addPart(botId:string,scopeId:string,userId:string,part:string):number|undefined{const session=getValidSession(botId,scopeId,userId);if(!session)return undefined;const value=part.trim();if(!value)return session.parts.length;session.parts.push(value);session.createdAt=Date.now();return session.parts.length;}
export function finish(botId:string,scopeId:string,userId:string):{value:string;scopeType:'personal'|'guild'}|undefined{const session=getValidSession(botId,scopeId,userId);if(!session)return undefined;sessions.delete(key(botId,scopeId,userId));return {value:session.parts.join('\n\n'),scopeType:session.scopeType};}
export function cancel(botId:string,scopeId:string,userId:string):void{sessions.delete(key(botId,scopeId,userId));}
export function getPartCount(botId:string,scopeId:string,userId:string):number{return getValidSession(botId,scopeId,userId)?.parts.length??0;}
