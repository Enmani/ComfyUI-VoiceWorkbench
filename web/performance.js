import { BASE, seconds, element, button, request, api } from "./common.js";

export const performanceMethods = {
performanceKey() { return `ds-performance:${this.path}:${this.line().id}`; },
buildPerformanceControls() {
    this.performanceCandidates ||= {};
    const card=element("details","ds-performance");card.open=!!this.performanceOpen;this.performanceCard=card;
    card.append(element("summary","","Generate & perform"));
    card.addEventListener("toggle",()=>{if(card.open)this.refreshVersions();});
    card.addEventListener("toggle",()=>{this.performanceOpen=card.open;});
    const body=element("div","ds-performance-body");
    const modelRow=element("div","ds-performance-row");this.performanceEngine=element("select");this.performanceEngine.setAttribute("aria-label","Speech engine");
    for(const entry of this.engineEntries || []){const opt=element("option","",entry.label + (entry.available ? "" : " · Configure first"));opt.value=entry.id;opt.disabled=!entry.available;this.performanceEngine.append(opt);}
    modelRow.append(element("span","","Engine"),this.performanceEngine);body.append(modelRow);
    const direction=element("textarea");direction.rows=2;direction.maxLength=300;direction.setAttribute("aria-label","Performance direction");direction.placeholder="For example: Calm and restrained, asking gently.";this.performanceDirection=direction;
    const label=element("label","","Performance direction");label.append(direction);body.append(label);
    const row=element("div","ds-performance-row");this.performanceStrength=element("input");this.performanceStrength.type="range";this.performanceStrength.min=".1";this.performanceStrength.max=".8";this.performanceStrength.step=".05";this.performanceStrength.setAttribute("aria-label","Emotion strength");this.performanceStrengthValue=element("span","ds-muted");
    this.performanceStrengthLabel=element("span","","Emotion strength");row.append(this.performanceStrengthLabel,this.performanceStrength,this.performanceStrengthValue);
    this.performanceDurationLabel=element("span","","Target seconds (0 keeps current duration)");this.performanceDuration=element("input");this.performanceDuration.type="number";this.performanceDuration.min="0";this.performanceDuration.max="15";this.performanceDuration.step=".1";this.performanceDuration.setAttribute("aria-label","AuKTarget duration in seconds");row.append(this.performanceDurationLabel,this.performanceDuration);
    for(const control of [direction,this.performanceStrength,this.performanceEngine,this.performanceDuration]) for(const event of ["input","change"]) control.addEventListener(event,()=>this.commitPerformanceControls());
    this.performanceGenerate=button("Generate new take",()=>this.generatePerformance());this.performanceAdopt=button("Apply take",()=>this.adoptPerformance());row.append(this.performanceGenerate);body.append(row);
    this.performanceHint=element("p","ds-muted");body.append(this.performanceHint);
    this.performanceStatus=element("p","ds-muted");
    this.performancePlayer=element("audio");
    body.append(this.buildVersionControls());
    card.append(body);
    try {const saved=JSON.parse(sessionStorage.getItem(this.performanceKey())||"null");if(saved?.candidate_path)this.performanceCandidates[this.line().id]=saved;}catch{}
    this.updatePerformanceControls();this.refreshVersions();return card;
  },
updatePerformanceControls() {
    if(!this.performanceGenerate)return;
    const setting=this.line().performance_options||{direction:"Calm and restrained, asking gently",strength:.65},candidate=this.performanceCandidates[this.line().id],blocked=this.busy||!!this.drag;
    if(document.activeElement!==this.performanceDirection)this.performanceDirection.value=setting.direction;
    if(document.activeElement!==this.performanceStrength)this.performanceStrength.value=String(setting.strength);
    this.performanceStrengthValue.textContent=Number(setting.strength).toFixed(2);
    const auk=setting.engine==="AuK", system=(setting.engine||"System")==="System";
    if(document.activeElement!==this.performanceEngine)this.performanceEngine.value=setting.engine||"System";
    if(document.activeElement!==this.performanceDuration)this.performanceDuration.value=String(setting.target_seconds||0);
    this.performanceEngine.disabled=blocked;this.performanceDuration.disabled=blocked;
    for(const control of [this.performanceStrengthLabel,this.performanceStrength,this.performanceStrengthValue])control.hidden=auk||system;
    this.performanceDuration.hidden=this.performanceDurationLabel.hidden=!auk;
    this.performanceGenerate.textContent="Generate take";
    this.performanceGenerate.title="Generate a new take and retain the current recording";
    this.performanceHint.textContent=system?"System speech is a quick-start voice. It does not clone the reference or apply emotion direction. Configure IndexTTS2 for AI voice and emotion generation.":auk?"Edit the audible take, including pitch and timing. Applying it resets baked controls. Previous versions remain available. Regenerate changed text first.":"Use this line's source as the voice reference. Applying a new take keeps global speed and pitch and clears local edits tied to the previous recording.";
    this.performanceDirection.disabled=blocked||system;this.performanceStrength.disabled=blocked;this.performanceGenerate.disabled=blocked||!this.engineEntries?.some(entry=>entry.id===(setting.engine||"System")&&entry.available);
    this.updateVersionControls();
    const valid=!!candidate&&candidate.text===(this.line().draft_text??this.line().text)&&candidate.source_audio===this.line().audio_path;
    this.performanceAdopt.disabled=blocked||!valid;this.performancePlayer.hidden=!candidate;
    if(candidate){const url=api.apiURL(`${BASE}/performance-media?path=${encodeURIComponent(candidate.candidate_path)}`);if(this.performancePlayer.getAttribute("src")!==url)this.performancePlayer.src=url;
      const names=["Happy","Angry","Sad","Afraid","Disgusted","Melancholic","Surprised","Calm"],v=candidate.vector||[];
      this.performanceStatus.textContent=`${valid?"Ready to apply":"Outdated candidate: text or source changed"} · ${candidate.direction} · ${Number(candidate.duration).toFixed(2)} s · ${v.map((n,i)=>n>.01?`${names[i]} ${n.toFixed(2)}`:"").filter(Boolean).join(" / ")}`;
    }else this.performanceStatus.textContent="Generation runs in the task queue. Your current recording and edits are retained.";
  },
commitPerformanceControls() {
    if(this.busy||!this.performanceDirection||!this.performanceStrength)return;
    const strength=Number(this.performanceStrength.value);if(!Number.isFinite(strength)||strength<.1||strength>.8)return;
    const seconds=Number(this.performanceDuration.value);if(!Number.isFinite(seconds)||seconds<0||seconds>15)return;
    const before=this.snapshot();this.line().performance_options={direction:this.performanceDirection.value,strength,engine:this.performanceEngine.value,target_seconds:seconds};
    this.checkpoint(before);this.preserveDraft();this.updateControls();
  },
async generatePerformance() {
    if(this.busy||this.drag||!this.document)return;
    if(this.performanceEngine?.value==="AuK"){
      const target=Number(this.performanceDuration.value);
      if(!this.performanceDuration.checkValidity()||!Number.isFinite(target)||target<0||target>15){this.setStatus("Target duration must be 0 (keep current) or at most 15 seconds.","error");return;}
      if(this.textPending()){this.setStatus("Regenerate changed text with a speech engine before using AuK.","error");return;}
    }
    this.commitPerformanceControls();
    this.pausePlayers();this.performancePlayer?.pause();this.performanceOpen=true;this.performanceCard.open=true;
    this.busy=true;this.setStatus("Submitting a full-line generation task…");
    try {
      const ticket=await request("/performance",{path:this.path,line_id:this.line().id,document:this.document,base_revision:this.document.revision});
      const until=Date.now()+3600000;
      while(Date.now()<until){
        const state=await request(`/performance-status?path=${encodeURIComponent(ticket.request_path)}`);
        if(state.state==="error")throw new Error(state.message);
        if(state.state==="done"){
          const c=state.candidate,entry={candidate_path:state.candidate_path,text:c.text,source_audio:c.source_audio,direction:c.options.direction,duration:c.generation.duration,vector:c.generation.emo_vector};
          this.performanceCandidates[c.line_id]=entry;try{sessionStorage.setItem(this.performanceKey(),JSON.stringify(entry));}catch{}
          this.setStatus(c.analysis_ready===false?"The new take is available under Compare. Alignment failed, so it cannot be edited yet.":"New take added to Compare. Click Edit version to apply it. Your current take is retained.","ok");break;
        }
        this.setStatus(state.message);
        const historyResponse=await api.fetchApi(`/history/${ticket.prompt_id}`);const history=await historyResponse.json();
        if(history[ticket.prompt_id]?.status?.status_str==="error")throw new Error("The generation task failed or was cancelled. Check the queue log.");
        if(state.state==="queued") {const q=await (await api.fetchApi("/queue")).json();const found=[...(q.queue_running||[]),...(q.queue_pending||[])].some(item=>item[1]===ticket.prompt_id);if(!found&&!history[ticket.prompt_id])throw new Error("The generation task was removed from the queue.");}
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
      if(Date.now()>=until)throw new Error("Timed out waiting. Check the task queue; generated files are retained.");
    }catch(error){this.setStatus(`Generation failed: ${error.message}`,"error");}
    finally{this.busy=false;this.refreshEditing();await this.refreshVersions(this.performanceCandidates[this.line().id]?.candidate_path);}
  },
buildVersionControls() {
    this.versionEntries=[];
    const box=element("div","ds-versions"),row=element("div","ds-performance-row");
    this.versionSave=button("Save new version",()=>this.changeVersion("save"));
    this.versionSave.title="Save this recording and its edits as a separate version";
    const more=element("details","ds-version-menu");const moreLabel=element("summary","","⋯");moreLabel.setAttribute("aria-label","More version actions");more.append(moreLabel);
    this.versionRefresh=button("Refresh versions",()=>{more.open=false;this.refreshVersions();});more.append(this.versionRefresh);
    this.versionSelect=element("select");this.versionSelect.setAttribute("aria-label","Versions");
    const refreshOnOpen=()=>{if(Date.now()-(this.versionRefreshAt||0)>1000){this.versionRefreshAt=Date.now();this.refreshVersions();}};
    this.versionSelect.addEventListener("focus",refreshOnOpen);this.versionSelect.addEventListener("pointerdown",refreshOnOpen);
    this.versionSelect.addEventListener("change",()=>{this.pausePlayers();this.updateVersionSelection();});
    this.versionRestore=button("Edit version",()=>this.changeVersion("restore"));
    row.append(element("strong","","Versions"),this.versionSave,more);
    const choice=element("div","ds-performance-row");choice.append(this.versionSelect,this.versionRestore);
    this.versionInfo=element("p","ds-muted");
    const players=element("div","ds-version-players");
    for(const [key,label] of [["versionCurrentPlayer","Current"],["versionSelectedPlayer","Compare"]]){
      const card=element("div");card.append(element("strong","",label));
      this[key]=element("audio");this[key].controls=true;this[key].preload="metadata";this[key].setAttribute("aria-label",label+" player");
      this[key].addEventListener("play",()=>this.pausePlayers(this[key]));card.append(this[key]);players.append(card);
    }
    box.append(row,choice,this.versionInfo,players,element("p","ds-muted","Click Edit version to continue, or Save new version to keep a separate take. Edits save automatically; Preview updates the audio."));
    return box;
  },
async refreshVersions(preferred) {
    if(!this.document||!this.versionSelect)return;
    const select=this.versionSelect,id=this.line().id,path=this.path,old=preferred||select.value;
    const token=(this.versionFetchToken||0)+1;this.versionFetchToken=token;
    try {
      const data=await request(`/versions?path=${encodeURIComponent(path)}&line_id=${encodeURIComponent(id)}`);
      if(this.versionSelect!==select||this.line().id!==id||this.path!==path||token!==this.versionFetchToken)return;
      this.versionEntries=data.versions;
      select.replaceChildren();
      for(const [index,entry] of data.versions.entries()){
        const title=entry.direction||entry.label||"Saved";const short=[...title].slice(0,12).join("")+([...title].length>12?"…":"");
        const opt=element("option","",`V${data.versions.length-index} · ${short} · ${seconds(entry.duration)}`);
        opt.title=`${entry.label} · ${entry.created_at.replace("T"," ")} · ${entry.direction||""} · ${entry.text}`;opt.value=entry.version_path;select.append(opt);
      }
      if(!data.versions.length)select.append(element("option","","No saved versions"));
      if(data.versions.some(x=>x.version_path===old))select.value=old;
      this.versionCurrentPlayer.src=api.apiURL(`${BASE}/version-media?path=${encodeURIComponent(path)}&line_id=${encodeURIComponent(id)}&version_path=current&revision=${data.revision}`);
      this.versionCurrentPlayback=data.current_playback;this.updateVersionSelection();
    }catch(error){if(this.versionSelect===select)this.versionInfo.textContent=`Versions could not be loaded: ${error.message}`;}
  },
updateVersionSelection() {
    const entry=this.versionEntries?.find(x=>x.version_path===this.versionSelect.value);
    this.versionSelectedPlayer.hidden=!entry;
    if(entry){this.versionSelectedPlayer.src=api.apiURL(`${BASE}/version-media?path=${encodeURIComponent(this.path)}&line_id=${encodeURIComponent(this.line().id)}&version_path=${encodeURIComponent(entry.version_path)}`);
      this.versionInfo.textContent=`${entry.label} · ${entry.created_at.replace("T"," ")}${entry.adoptable===false?" · Preview only: "+entry.analysis_note:""}`;
      this.versionInfo.title=`${entry.direction||entry.label} · Compare: ${entry.playback} · Current: ${this.versionCurrentPlayback||"Saved state"}`;
    }else this.versionInfo.textContent="Generated candidates are retained when the page is closed.";
    this.updateVersionControls();
  },
updateVersionControls() {
    if(!this.versionSelect)return;
    const blocked=this.busy||!!this.drag,entry=this.versionEntries?.find(x=>x.version_path===this.versionSelect.value);
    this.versionSave.disabled=blocked;this.versionSelect.disabled=blocked;this.versionRefresh.disabled=blocked;
    this.versionRestore.disabled=blocked||!entry||entry.adoptable===false||(entry.kind==="candidate"&&entry.text!==(this.line().draft_text??this.line().text));
    this.versionRestore.textContent="Edit version";
    this.versionRestore.title=entry?.kind==="candidate"?(entry.baked_controls?"This take includes the input edits. Applying it resets speed, pitch and local anchors":"Keep global speed and pitch; clear local edits tied to the old recording. Text must match"):"Restore this line's text, recording and edits";
  },
async changeVersion(action) {
    if(this.busy||this.drag||this.hasInvalidSettings())return;
    this.commitPerformanceControls();this.pausePlayers();
    const version=this.versionSelect.value;this.busy=true;this.refreshEditing();
    try {
      const data=await request(action==="save"?"/version-save":"/version-restore",{path:this.path,line_id:this.line().id,document:this.document,base_revision:this.document.revision,version_path:version});
      this.document=data.document;this.savedSignature=this.draftSignature();this.preserveDraft();
      if(action==="restore"){this.undoStack=[];this.redoStack=[];this.selected=null;this.selectedPoint=null;}
      this.busy=false;this.build();await this.refreshVersions(data.version_path||version);
      this.setStatus(action==="save"?"Saved as a new version. Previous versions remain available.":"Version loaded. The previous state was archived.","ok");
    }catch(error){this.setStatus(`Version action failed: ${error.message}`,"error");}
    finally{this.busy=false;this.refreshEditing();}
  },
async adoptPerformance() {
    const candidate=this.performanceCandidates[this.line().id];if(this.busy||this.drag||!candidate)return;
    this.pausePlayers();this.performancePlayer?.pause();this.busy=true;this.setStatus("Applying the new take and archiving the previous recording…");
    try{
      const data=await request("/performance-adopt",{path:this.path,document:this.document,base_revision:this.document.revision,candidate_path:candidate.candidate_path});
      const key=this.performanceKey(),id=this.line().id;this.document=data.document;delete this.performanceCandidates[id];try{sessionStorage.removeItem(key);}catch{}
      this.savedSignature=this.draftSignature();this.preserveDraft();this.undoStack=[];this.redoStack=[];this.selected=null;this.selectedPoint=null;this.busy=false;this.build();
      this.setStatus("New take applied. Previous audio and edits are archived. Click Preview to apply global speed and pitch.","ok");
    }catch(error){this.setStatus(`Apply failed: ${error.message}. Current recording retained.`,"error");}
    finally{this.busy=false;this.refreshEditing();}
  }
};
