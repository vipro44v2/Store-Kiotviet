import { query } from "@/lib/db/client";
export function notify(severity:"info"|"warning"|"critical",title:string,message:string,entityType?:string,entityId?:string){return query("INSERT INTO notifications(type,severity,title,message,entity_type,entity_id) VALUES('system',$1,$2,$3,$4,$5)",[severity,title,message,entityType??null,entityId??null]);}
