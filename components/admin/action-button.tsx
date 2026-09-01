"use client";
import { useState } from "react";
export function ActionButton({action,label,variant="primary"}:{action:string;label:string;variant?:"primary"|"secondary"}){const[state,setState]=useState("");return <div className="action-wrap"><button className={`button button-${variant}`} type="button" disabled={state==="Queueing..."} onClick={async()=>{setState("Queueing...");const response=await fetch(`/api/admin/sync/${action}`,{method:"POST"});setState(response.ok?"Queued":"Failed")}}>{label}</button>{state&&<small>{state}</small>}</div>}
