// Minimal CDP transport for local disposable-browser experiments, without
// automation-library focus/prerender overrides or auto-attached page sessions.
export async function connectCDP(endpoint) {
 const socket=new WebSocket(endpoint),pending=new Map(),listeners=new Map();let nextId=0;
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{
  const message=JSON.parse(String(event.data));
  if(message.id){
   const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);
   if(message.error)task.reject(Error(message.error.message));else task.resolve(message.result);
  }else for(const listener of listeners.get(message.method)??[])listener(message.params,message.sessionId);
 });
 socket.addEventListener('close',()=>{
  for(const task of pending.values()){clearTimeout(task.timer);task.reject(Error('CDP connection closed'));}pending.clear();
 });
 return {
  send(method,params={},sessionId){return new Promise((resolve,reject)=>{
   const id=++nextId;
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},30000);
   pending.set(id,{resolve,reject,timer});
   socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });},
  on(method,listener){if(!listeners.has(method))listeners.set(method,[]);listeners.get(method).push(listener);},
  close(){socket.close();},
 };
}
