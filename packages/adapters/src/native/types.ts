import type { LiveSession, RuntimeModel } from '../../../core/src/researchWorkbench.ts';
export interface NativeApproval { id:string; kind:'permission'|'question'; title:string;description:string;options:Array<{id:string;label:string}>; questions?:Array<{key:string;question:string;options:Array<{label:string;description?:string}>;multiSelect:boolean;allowOther:boolean;allowEmpty:boolean}>;unsupported?:boolean }
export interface NativeSnapshot { session:NativeRecord; messages:Array<{id:string;role:string;text:string;at?:string;final?:boolean}>;activity:Array<{id:string;tool:string;summary:string;status?:string;target?:string;description?:string;error?:string;at?:string}>;approvals:NativeApproval[];activeTurn?:unknown;hasOlderMessages?:boolean }
export interface NativeRecord extends LiveSession { nativeId?:string; native?:Record<string,any>; error?:string;lastMessageAt?:string;lastActivityAt?:string; }
export interface NativeDriver {
 models():Promise<RuntimeModel[]>;
 open(record:NativeRecord):Promise<NativeSnapshot>;
 inspect(record:NativeRecord):Promise<NativeSnapshot>;
 send(record:NativeRecord,message:string):Promise<{accepted:boolean;status?:string}>;
 interrupt(record:NativeRecord):Promise<{ok:boolean}>;
 configure(record:NativeRecord,input:{model?:string|null;thinkingOptionId?:string|null;permissionPreset?:'auto'|'danger-full-access';modeId?:'auto'|'full-access'}):Promise<{ok:boolean;session:NativeRecord;notice?:string}>;
 approve(record:NativeRecord,id:string,option:string):Promise<{ok:boolean}>;
 answer(record:NativeRecord,id:string,answers:Record<string,{selected:string[];text?:string}>,cancel?:boolean):Promise<{ok:boolean}>;
 close():Promise<void>;
}
export type NativeUpdate=(record:NativeRecord,snapshot?:NativeSnapshot)=>void;
