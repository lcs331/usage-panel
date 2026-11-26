// Workspace browsing is independent of a model request. Durable state is IDs only.
(() => {
  const base = { data: PhoneWorkspace.data, ...PhoneWorkspace.methods };
  const terminal = state => ['completed', 'failed', 'interrupted', 'cancelled', 'rejected'].includes(state);
  PhoneWorkspace.data = function () {
    return { ...base.data(), workspaceRuns: {}, workspaceDrafts: {}, workspaceUnread: {},
      workspaceReadBusy: false, workspaceReadSequence: 0, workspaceListStatus: '', workspaceListFailed: false,
      workspaceComputerState: 'idle', workspaceActiveThread: '', workspaceAtBottom: true,
      workspaceNewReply: false, workspaceCopyStatus: '', workspaceRenameOpen: false, workspaceRenameText: '',
      workspaceClock: Date.now(), workspaceClockTimer: null, workspaceLifecycleReady: false,
      workspaceOwner: '', workspaceRunHistory: [], workspaceRemoved: {}, workspaceServerRequest: '', workspaceServerJob: '', workspacePreparedDrafts: {} };
  };
  Object.assign(PhoneWorkspace.computed, {
    workspaceRun() { return this.workspaceRuns[this.sessionDevice] || null; },
    workspaceDeviceBlocked() {
      return !!(this.workspaceRun && !terminal(this.workspaceRun.state)) || (!this.workspaceRun && this.sessionCanRecover) || ['running', 'unknown'].includes(this.workspaceComputerState);
    },
    workspaceCanBrowse() { return !!this.sessionDevice && !this.workspaceSetupOpen; },
    workspaceHasTask() { return !!this.workspaceRun || !!this.sessionDraft || this.sessionCanRecover; },
    workspaceCompletedChild() { return this.workspaceRun?.state === 'completed' ? this.workspaceRun.childId : ''; },
    workspaceTitle() { return this.workspaceView === 'task' ? this.sessionTitle(this.workspaceRun?.childId) : this.sessionSelected ? this.sessionTitle(this.sessionSelected) : '选择一条会话'; },
    workspaceGroups() {
      const sorted = [...this.sessionRows].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
      return [{ name: '派生会话', rows: sorted.filter(row => row.kind === 'derived' || row.parentThreadId) },
        { name: '电脑原会话', rows: sorted.filter(row => row.kind !== 'derived' && !row.parentThreadId) }];
    },
    workspaceSelectedRow() { return this.sessionRows.find(row => row.sourceThreadId === this.sessionSelected); },
    workspaceSourceId() { return this.workspaceSelectedRow?.parentThreadId || this.sessionPreview?.parentThreadId || ''; },
    workspaceRunStatus() {
      const run = this.workspaceRun;
      if (!run) return this.workspaceComputerState === 'unknown' ? '电脑上有结果未知的请求，先核查状态再发送。' : this.workspaceComputerState === 'running' ? '电脑正在处理其他消息，可以继续浏览。' : '';
      const elapsed = Math.max(0, Math.floor((this.workspaceClock - run.since) / 1000));
      const duration = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
      return ({ sending: '正在发送到电脑', running: `电脑已接收，等待回复 · ${duration}`,
        recovering: `连接中断，正在恢复查询 · ${duration}`, unknown: '结果未知，请核查电脑会话；不会自动重发。',
        completed: '回复已收到，可以继续对话。', failed: '本轮失败，可核对电脑会话。', interrupted: '本轮已中断。',
        cancelled: '草稿已取消。', rejected: '电脑未接收这条消息，草稿已保留。' })[run.state] || '正在核查本次请求。';
    },
    workspaceTranscript() {
      const run = this.workspaceRun;
      const isRun = run && (this.workspaceView === 'task' || this.sessionSelected === run.childId);
      const messages = this.workspaceView === 'task' ? this.workspaceRunHistory : this.workspaceMessages;
      if (!isRun || run.historyLoaded) return messages;
      const pending = [];
      const promptAlreadyRead = messages.filter(message => message.role === 'user' && message.text === run.prompt).length > (run.baselinePromptCount || 0);
      if (run.prompt && !promptAlreadyRead) pending.push({ id: run.requestId + '-user', role: 'user', text: run.prompt, complete: true });
      const replyAlreadyRead = promptAlreadyRead && messages.at(-1)?.role === 'assistant' && messages.at(-1).text === run.finalReply;
      if (run.finalReply && !replyAlreadyRead) pending.push({ id: run.requestId + '-assistant', role: 'assistant', text: run.finalReply, complete: true });
      return [...messages, ...pending];
    }
  });
  Object.assign(PhoneWorkspace.methods, {
    workspaceValid(run) {
      return run.owner === this.userId() && run.epoch === this.sessionEpoch && this.workspaceRuns[run.device]?.requestId === run.requestId;
    },
    saveWorkspaceRuns() {
      const runs = Object.values(this.workspaceRuns).filter(run => !terminal(run.state)).map(run => ({
        owner: run.owner, device: run.device, requestId: run.requestId, operation: run.operation,
        sourceThreadId: run.sourceThreadId, childId: run.childId, jobId: run.jobId, since: run.since
      }));
      if (runs.length) localStorage.setItem('nc_workspace_runs', JSON.stringify(runs));
      else localStorage.removeItem('nc_workspace_runs');
    },
    restoreWorkspaceRuns() {
      if (this.workspaceOwner === this.userId()) return;
      for (const run of Object.values(this.workspaceRuns)) { clearTimeout(run.timer); clearTimeout(run.expiryTimer); }
      this.workspaceRuns = {}; this.workspaceDrafts = {}; this.workspaceUnread = {}; this.workspacePreparedDrafts = {}; this.workspaceOwner = this.userId();
      let saved = [];
      try { saved = JSON.parse(localStorage.getItem('nc_workspace_runs')) || []; } catch { /* invalid records are ignored */ }
      if (!Array.isArray(saved)) saved = [];
      // Upgrade old one-request recovery without copying any prompt or reply.
      if (!saved.length) {
        try {
          const result = JSON.parse(localStorage.getItem('nc_session_result'));
          const receipt = JSON.parse(localStorage.getItem('nc_session_receipt'));
          if (result?.owner === this.userId()) saved.push({ ...result, operation: receipt?.operation || 'execute' });
        } catch { /* no old recovery */ }
      }
      for (const row of saved) {
        if (row?.owner !== this.userId() || typeof row.device !== 'string' || !row.device || typeof row.requestId !== 'string' ||
            !row.requestId || !['execute', 'continue'].includes(row.operation)) continue;
        this.workspaceRuns[row.device] = { owner: row.owner, device: row.device, requestId: row.requestId,
          operation: row.operation, sourceThreadId: row.sourceThreadId || '', childId: row.childId || '', jobId: row.jobId || '',
          since: Number.isFinite(row.since) ? row.since : Date.now(), epoch: this.sessionEpoch,
          state: 'recovering', prompt: '', finalReply: '', timer: null };
      }
      if (Object.keys(this.workspaceRuns).length) {
        this.saveWorkspaceRuns(); localStorage.removeItem('nc_session_result');
        if (this.phoneRecord('nc_session_receipt')?.operation !== 'prepare') localStorage.removeItem('nc_session_receipt');
      }
    },
    async workspaceCommand(operation, options = {}, device = this.sessionDevice) {
      const owner = this.userId(), epoch = this.sessionEpoch, requestId = crypto.randomUUID();
      await this.sessionRpc('enqueue_session_request', { p_device: device, p_payload: {
        requestId, operation, relayVersion: 1, expiresAt: new Date(Date.now() + 120000).toISOString(), ...options
      } });
      return this.workspaceReceipt(requestId, device, owner, epoch);
    },
    async workspaceReceipt(requestId, device, owner, epoch) {
      for (let i = 0; i < 35; i++) {
        if (owner !== this.userId() || epoch !== this.sessionEpoch) throw new Error('workspace_changed');
        const rows = await this.sessionRpc('session_command_receipt', { p_device: device, p_request: requestId });
        if (owner !== this.userId() || epoch !== this.sessionEpoch) throw new Error('workspace_changed');
        const row = rows?.[0];
        if (row && ['done', 'failed'].includes(row.status)) {
          const reply = row.result ? JSON.parse(row.result) : { v: 1, status: 'unknown' };
          if (reply?.v !== 1 || typeof reply.status !== 'string') throw new Error('invalid_receipt');
          return reply;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('receipt_timeout');
    },
    resetPhoneSessions() {
      this.workspaceReadSequence++;
      base.resetPhoneSessions.call(this);
      this.workspaceReadBusy = false; this.workspaceRenameOpen = false;
      this.workspaceComputerState = 'idle'; this.workspaceActiveThread = ''; this.workspaceListStatus = '';
      this.restoreWorkspaceRuns();
      this.projectWorkspaceRun();
    },
    async loadSessionDevices() {
      await base.loadSessionDevices.call(this);
      this.restoreWorkspaceRuns(); this.installWorkspaceLifecycle();
      if (this.sessionDevice) {
        this.projectWorkspaceRun();
        if (this.sessionListReady) {
          if (!this.sessionRows.length) await this.refreshWorkspaceSessions();
          if (this.sessionSelected && !this.workspaceMessages.length) await this.openWorkspaceSession(this.sessionSelected);
        }
      }
      for (const run of Object.values(this.workspaceRuns)) if (!terminal(run.state)) this.queryWorkspaceRun(run, true);
    },
    applyPhoneReceipt(reply, operation) {
      base.applyPhoneReceipt.call(this, reply, operation);
      if (reply.status === 'draft' && reply.data?.sourceThreadId && reply.data?.newThreadId) {
        const draft = { ...reply.data, state: 'draft' };
        this.workspacePreparedDrafts[this.sessionDevice + ':' + draft.sourceThreadId] = draft;
        this.workspacePreparedDrafts[this.sessionDevice + ':' + draft.newThreadId] = draft;
        this.sessionDraft = [draft.sourceThreadId, draft.newThreadId].includes(this.sessionSelected) ? draft : null;
        this.upsertWorkspaceChild(reply.data, 'draft');
      }
    },
    projectWorkspaceRun() {
      const run = this.workspaceRun;
      this.sessionBusy = false;
      this.sessionCanRecover = run ? !terminal(run.state) : this.recoverablePhoneReceipt()?.operation === 'prepare';
      this.sessionResultPending = !!run && ['sending', 'running', 'recovering'].includes(run.state);
      this.sessionResultRequest = run?.requestId || '';
      this.sessionFinalReply = run?.finalReply || '';
      this.sessionResultExpires = run?.expiresAt || '';
      this.sessionSubmitted = !!run && run.state !== 'rejected';
      if (run?.childId && this.sessionDraft?.state !== 'draft') this.sessionDraft = { sourceThreadId: run.sourceThreadId, newThreadId: run.childId,
        jobId: run.jobId, state: run.state };
    },
    async listPhoneSessions(next = false) { return this.refreshWorkspaceSessions(next); },
    async refreshWorkspaceSessions(next = false) {
      if (!this.sessionDevice || this.workspaceReadBusy) return;
      const device = this.sessionDevice, epoch = this.sessionEpoch;
      const prior = this.sessionRows;
      this.workspaceReadBusy = true; this.workspaceListFailed = false; this.workspaceListStatus = '正在读取会话列表…';
      try {
        const reply = await this.workspaceCommand('list', next && this.sessionCursor ? { cursor: this.sessionCursor } : {});
        if (device !== this.sessionDevice || epoch !== this.sessionEpoch) return;
        if (reply.status !== 'listed' || !Array.isArray(reply.data?.sessions)) {
          if (reply.status === 'disabled') { this.sessionSetupBlocked = true; this.sessionListReady = false; }
          throw new Error('list_unavailable');
        }
        this.workspaceSetupOpen = false; this.sessionSetupBlocked = false; this.sessionListReady = true;
        this.sessionRows = [...new Map([...(next ? prior : []), ...reply.data.sessions].map(row => [row.sourceThreadId, row])).values()];
        this.sessionCursor = reply.data.nextCursor || null;
        this.workspaceComputerState = reply.data.computerState || 'idle'; this.workspaceActiveThread = reply.data.activeThreadId || '';
        this.workspaceServerRequest = reply.data.activeRequestId || ''; this.workspaceServerJob = reply.data.activeJobId || '';
        this.workspaceListStatus = this.sessionRows.length ? '' : '电脑已连接，暂无可用会话。';
        this.sessionStatus = this.workspaceListStatus || '会话列表已更新。'; this.rememberWorkspace();
      } catch {
        if (device === this.sessionDevice && epoch === this.sessionEpoch) {
          this.workspaceListFailed = true;
          this.workspaceListStatus = '电脑离线或列表暂不可读取；已保留上次列表，请检查连接后刷新。';
          this.sessionStatus = this.workspaceListStatus;
        }
      } finally { if (device === this.sessionDevice && epoch === this.sessionEpoch) this.workspaceReadBusy = false; }
    },
    workspaceDraftKey(id = this.sessionSelected) { return this.sessionDevice + ':' + id; },
    saveWorkspaceDraft() { if (this.sessionSelected) this.workspaceDrafts[this.workspaceDraftKey()] = this.sessionTask; },
    async openWorkspaceSession(id, options = {}) {
      if (!this.sessionDevice || !id) return;
      this.saveWorkspaceDraft();
      const preserveScroll = !!options.preserveScroll;
      const sequence = ++this.workspaceReadSequence, device = this.sessionDevice, epoch = this.sessionEpoch;
      this.workspaceReadBusy = false;
      this.sessionSelected = id; this.workspaceView = 'source'; this.workspaceSidebarOpen = false;
      this.sessionDraft = this.workspacePreparedDrafts[device + ':' + id] || null;
      this.workspaceComposeOpen = false; this.workspaceRenameOpen = false; this.sessionPreview = null;
      this.sessionCwdConsent = false; this.sessionContextConsent = false;
      this.sessionTask = this.workspaceDrafts[this.workspaceDraftKey(id)] || '';
      this.workspaceUnread[this.workspaceDraftKey(id)] = false;
      if (!options.keepMessages) { this.workspaceMessages = []; this.workspaceHistoryComplete = false; }
      this.workspaceCursor = null; this.workspaceHistoryStatus = '正在读取会话正文…';
      this.rememberWorkspace();
      try {
        const reply = await this.workspaceCommand('preview', { sourceThreadId: id });
        if (sequence !== this.workspaceReadSequence || device !== this.sessionDevice || epoch !== this.sessionEpoch) return;
        if (reply.status !== 'previewed' || reply.data?.sourceThreadId !== id) throw new Error('preview_unavailable');
        this.sessionPreview = reply.data; this.sessionCwd = reply.data.cwd;
        this.workspaceCursor = reply.data.bodyVersion === 1 ? reply.data.nextMessageCursor : null;
        this.workspaceHistoryStatus = reply.data.bodyVersion === 1 ? '' : '电脑程序暂只支持短摘录，升级后可读取正文。';
        if (reply.data.bodyVersion === 1) {
          if (this.workspaceCursor) await this.loadWorkspaceMessages({ preserveScroll, reset: !!options.keepMessages });
          else this.workspaceHistoryComplete = true;
        }
      } catch {
        if (sequence === this.workspaceReadSequence && epoch === this.sessionEpoch)
          this.workspaceHistoryStatus = '正文暂未读到，请重新读取；已有请求不会重发。';
      }
      if (!preserveScroll) { this.workspaceAtBottom = true; this.workspaceNewReply = false; this.scrollWorkspaceBottom(); }
    },
    async previewPhoneSession() { return this.openWorkspaceSession(this.sessionSelected); },
    async loadWorkspaceMessages(options = {}) {
      if (!this.sessionPreview || !this.workspaceCursor || this.workspaceReadBusy) return;
      const sequence = this.workspaceReadSequence, epoch = this.sessionEpoch, device = this.sessionDevice;
      const preview = this.sessionPreview.previewId, source = this.sessionPreview.sourceThreadId, cursor = this.workspaceCursor;
      const scroll = this.workspaceScrollSnapshot();
      this.workspaceReadBusy = true; this.workspaceHistoryStatus = '正在读取会话正文…';
      try {
        const reply = await this.workspaceCommand('preview', { sourceThreadId: source, previewId: preview, cursor });
        if (sequence !== this.workspaceReadSequence || device !== this.sessionDevice || epoch !== this.sessionEpoch || this.sessionPreview?.previewId !== preview) return;
        const data = reply.data;
        if (reply.status !== 'messages' || data?.previewId !== preview || data.sourceThreadId !== source ||
          !Array.isArray(data.messages) || data.messages.length > 100 || (data.nextCursor !== null && typeof data.nextCursor !== 'string') || data.nextCursor === cursor)
          throw new Error('invalid_messages');
        const messages = options.reset ? [] : this.workspaceMessages.map(message => ({ ...message }));
        for (const part of data.messages) {
          if (typeof part.id !== 'string' || !['user', 'assistant'].includes(part.role) || typeof part.text !== 'string' ||
              !Number.isSafeInteger(part.offset) || part.offset < 0 || typeof part.complete !== 'boolean') throw new Error('invalid_message');
          const existing = messages.find(message => message.id === part.id);
          if (existing) {
            if (existing.role !== part.role || existing.complete || existing.text.length !== part.offset) throw new Error('invalid_chunk');
            existing.text += part.text; existing.complete = part.complete;
          } else { if (part.offset !== 0) throw new Error('missing_chunk'); messages.push({ ...part }); }
        }
        if (data.nextCursor === null && messages.some(message => !message.complete)) throw new Error('incomplete_messages');
        this.workspaceMessages = messages; this.workspaceCursor = data.nextCursor; this.workspaceHistoryComplete = data.nextCursor === null;
        this.workspaceHistoryStatus = this.workspaceHistoryComplete ? (messages.length ? '' : '暂无可展示的用户消息或 AI 回复。') : '已读取部分正文，可继续加载。';
        if (this.workspaceHistoryComplete && this.workspaceRun?.childId === source && terminal(this.workspaceRun.state)) this.workspaceRun.historyLoaded = true;
        this.afterWorkspaceRender(() => {
          const element = this.$refs?.workspaceTranscript;
          if (!element) return;
          if (options.preserveScroll || !scroll.atBottom) element.scrollTop = scroll.top;
          else element.scrollTop = element.scrollHeight;
        });
      } catch {
        if (sequence === this.workspaceReadSequence && epoch === this.sessionEpoch) this.workspaceHistoryStatus = '正文暂未读到，可再读取同一页，不会发送模型任务。';
      } finally { if (sequence === this.workspaceReadSequence && device === this.sessionDevice && epoch === this.sessionEpoch) this.workspaceReadBusy = false; }
    },
    async preparePhoneSession() {
      if (this.workspaceDeviceBlocked || this.sessionCanRecover || !this.sessionPreview || !this.sessionCwdConsent || !this.sessionCwd.trim() || this.sessionBusy) return;
      const sequence = this.workspaceReadSequence, device = this.sessionDevice, epoch = this.sessionEpoch;
      const source = this.sessionPreview.sourceThreadId;
      this.sessionBusy = true;
      let accepted = false;
      try {
        // Preparing is recoverable too: retain correlation before creating a child.
        const requestId = crypto.randomUUID(); this.rememberPhoneReceipt(requestId, 'prepare');
        await this.sessionRpc('enqueue_session_request', { p_device: device, p_payload: { requestId, operation: 'prepare', relayVersion: 1,
          expiresAt: new Date(Date.now() + 120000).toISOString(), sourceThreadId: source,
          previewId: this.sessionPreview.previewId, cwd: this.sessionCwd.trim(), confirmSharedCwd: true } });
        accepted = true;
        const reply = await this.workspaceReceipt(requestId, device, this.userId(), epoch);
        if (sequence !== this.workspaceReadSequence || device !== this.sessionDevice || epoch !== this.sessionEpoch) return;
        if (['failed', 'disabled', 'expired'].includes(reply.status)) {
          localStorage.removeItem('nc_session_receipt'); this.sessionCanRecover = false; this.sessionStatus = '电脑未创建草稿，请核对会话与工作目录。'; return;
        }
        if (reply.status !== 'draft' || reply.data?.sourceThreadId !== source || typeof reply.data.newThreadId !== 'string' || reply.data.newThreadId === source) throw new Error('prepare_failed');
        this.sessionDraft = { ...reply.data, state: 'draft' };
        this.workspacePreparedDrafts[device + ':' + source] = this.sessionDraft;
        this.workspacePreparedDrafts[device + ':' + reply.data.newThreadId] = this.sessionDraft;
        this.sessionSubmitted = false; this.sessionContextConsent = false;
        this.upsertWorkspaceChild(reply.data, 'draft'); this.sessionStatus = '独立草稿已准备好，填写消息后发送。';
        this.saveWorkspaceDraft(); this.sessionSelected = reply.data.newThreadId;
        this.sessionTask = this.workspaceDrafts[device + ':' + source] || ''; this.workspaceComposeOpen = true;
        this.rememberWorkspace();
        localStorage.removeItem('nc_session_receipt');
      } catch (error) {
        if (device === this.sessionDevice && epoch === this.sessionEpoch) {
          if (!accepted && [400, 401, 403, 404, 409, 422].includes(error?.status)) {
            localStorage.removeItem('nc_session_receipt'); this.sessionCanRecover = false; this.sessionStatus = '电脑未接收创建请求，请核对后再试。';
          } else { this.sessionCanRecover = true; this.sessionStatus = '草稿创建结果待核查，请查询上次请求，不要重复创建。'; }
        }
      }
      finally { if (device === this.sessionDevice && epoch === this.sessionEpoch) this.sessionBusy = false; }
    },
    upsertWorkspaceChild(data, state) {
      if (!data.newThreadId || data.newThreadId === data.sourceThreadId) return;
      if (this.workspaceRemoved[this.sessionDevice + ':' + data.newThreadId]) return;
      const previous = this.sessionRows.find(row => row.sourceThreadId === data.newThreadId);
      const name = data.name || previous?.name || this.sessionTitle(data.sourceThreadId) + ' · 派生 1';
      const row = { ...previous, sourceThreadId: data.newThreadId, name, kind: 'derived', parentThreadId: data.sourceThreadId,
        updatedAt: data.updatedAt || previous?.updatedAt || new Date().toISOString(), state, model: data.model || previous?.model || '' };
      this.sessionRows = [row, ...this.sessionRows.filter(item => item.sourceThreadId !== row.sourceThreadId)];
    },
    executePhoneSession() {
      const draft = this.sessionDraft;
      if (!draft || draft.state !== 'draft' || ![draft.sourceThreadId, draft.newThreadId].includes(this.sessionSelected) ||
          !this.sessionContextConsent || !this.sessionTask.trim() || this.sessionCanRecover || this.workspaceDeviceBlocked || this.sessionBusy) return;
      return this.startWorkspaceRun('execute', { sourceThreadId: draft.sourceThreadId, jobId: draft.jobId, childId: draft.newThreadId, cwd: draft.cwd });
    },
    continuePhoneSession() {
      const child = this.sessionPreview;
      if (!child?.canContinue || !this.workspaceHistoryReady || !this.sessionContextConsent || !this.sessionTask.trim() || this.workspaceDeviceBlocked || this.sessionBusy) return;
      return this.startWorkspaceRun('continue', { sourceThreadId: child.parentThreadId, jobId: child.sourceThreadId, childId: child.sourceThreadId,
        previewId: child.previewId, cwd: child.cwd });
    },
    async startWorkspaceRun(operation, details) {
      const prompt = this.sessionTask.trim(), device = this.sessionDevice;
      const run = { owner: this.userId(), epoch: this.sessionEpoch, device, requestId: crypto.randomUUID(), operation, ...details,
        state: 'sending', since: Date.now(), prompt, finalReply: '', historyLoaded: false, timer: null,
        baselinePromptCount: this.workspaceMessages.filter(message => message.role === 'user' && message.text === prompt).length };
      // Persist before dispatch. Failed persistence prevents dispatch.
      const previous = this.workspaceRuns[device]; this.workspaceRuns[device] = run;
      try { this.saveWorkspaceRuns(); } catch { this.workspaceRuns[device] = previous; this.sessionStatus = '无法保存请求关联，消息尚未发送。'; return; }
      clearTimeout(previous?.timer); clearTimeout(previous?.expiryTimer);
      localStorage.removeItem('nc_session_receipt'); localStorage.removeItem('nc_session_result');
      const active = this.workspaceRuns[device];
      this.workspaceRunHistory = this.workspaceMessages.map(message => ({ ...message }));
      this.workspaceSentPrompt = prompt; this.workspaceView = 'source'; this.workspaceComposeOpen = false;
      this.sessionSelected = details.childId; this.sessionTask = ''; this.workspaceDrafts[this.workspaceDraftKey(details.childId)] = '';
      this.workspaceDrafts[this.workspaceDraftKey(details.sourceThreadId)] = ''; this.sessionContextConsent = false;
      this.projectWorkspaceRun(); this.rememberWorkspace(); this.scrollWorkspaceBottom();
      if (operation === 'execute') {
        delete this.workspacePreparedDrafts[device + ':' + details.sourceThreadId];
        delete this.workspacePreparedDrafts[device + ':' + details.childId];
      }
      let accepted = false;
      try {
        const { childId, ...options } = details;
        await this.sessionRpc('enqueue_session_request', { p_device: device, p_payload: { requestId: active.requestId, operation,
          relayVersion: 1, expiresAt: new Date(Date.now() + 120000).toISOString(), ...options, prompt, confirmContext: true } });
        accepted = true;
        const reply = await this.workspaceReceipt(active.requestId, device, active.owner, active.epoch);
        if (!this.workspaceValid(active)) return;
        if (reply.status === 'running' || reply.status === 'completed') {
          if (reply.data?.newThreadId !== active.childId || reply.data?.sourceThreadId !== active.sourceThreadId) throw new Error('wrong_run');
          active.state = 'running'; this.upsertRunRow(active);
        } else if (['failed', 'disabled', 'expired'].includes(reply.status)) {
          active.state = 'rejected'; this.restoreRejectedWorkspaceDraft(active); this.saveWorkspaceRuns();
        } else active.state = 'unknown';
      } catch (error) {
        if (!this.workspaceValid(active)) return;
        if (!accepted && [400, 401, 403, 404, 409, 422].includes(error?.status)) {
          active.state = 'rejected'; this.restoreRejectedWorkspaceDraft(active); this.saveWorkspaceRuns();
        } else active.state = 'recovering';
      }
      if (!this.workspaceValid(active)) return;
      if (this.sessionDevice === device) this.projectWorkspaceRun();
      if (!terminal(active.state) && active.state !== 'unknown') await this.queryWorkspaceRun(active);
    },
    restoreRejectedWorkspaceDraft(run) {
      this.workspaceDrafts[run.device + ':' + run.childId] = run.prompt;
      if (this.sessionDevice === run.device && this.sessionSelected === run.childId) {
        this.sessionTask = run.prompt;
        if (run.operation === 'execute') {
          this.sessionSelected = run.sourceThreadId; this.workspaceComposeOpen = true;
          this.sessionDraft = { sourceThreadId: run.sourceThreadId, newThreadId: run.childId, jobId: run.jobId, cwd: run.cwd, state: 'draft' };
          this.workspacePreparedDrafts[run.device + ':' + run.sourceThreadId] = this.sessionDraft;
          this.workspacePreparedDrafts[run.device + ':' + run.childId] = this.sessionDraft;
        }
      }
      run.prompt = ''; run.historyLoaded = true;
    },
    upsertRunRow(run) {
      if (run.device !== this.sessionDevice) return;
      this.upsertWorkspaceChild({ newThreadId: run.childId, sourceThreadId: run.sourceThreadId,
        updatedAt: new Date(run.completedAt || run.since).toISOString() }, run.state);
    },
    async queryWorkspaceRun(run, checkStatus = false) {
      if (!this.workspaceValid(run) || run.querying) return;
      clearTimeout(run.timer); run.timer = null; run.querying = true;
      try {
        if (checkStatus || run.state === 'unknown') {
          const status = await this.workspaceCommand('status', { lookupId: run.requestId, ...(run.jobId ? { jobId: run.jobId } : {}) }, run.device);
          if (!this.workspaceValid(run)) return;
          if (status.data?.newThreadId) {
            if (run.childId && run.childId !== status.data.newThreadId) throw new Error('wrong_child');
            run.childId = status.data.newThreadId; run.sourceThreadId = status.data.sourceThreadId; run.jobId = status.data.jobId;
          }
          if (['failed', 'interrupted', 'cancelled'].includes(status.status)) { run.state = status.status; this.saveWorkspaceRuns(); return; }
          if (['unknown', 'disconnected'].includes(status.status)) { run.state = 'unknown'; return; }
          if (status.status === 'completed') run.confirmedComplete = true;
          if (status.status === 'running') run.state = 'running';
        }
        const reply = await this.sessionRpc('read_session_result', { p_device: run.device, p_request: run.requestId });
        if (!this.workspaceValid(run)) return;
        if (reply?.v !== 1 || !['ready', 'pending', 'failed', 'interrupted', 'unknown', 'expired', 'unavailable'].includes(reply.status)) throw new Error('invalid_result');
        if (reply.newThreadId) {
          if (run.childId && reply.newThreadId !== run.childId || run.sourceThreadId && reply.sourceThreadId !== run.sourceThreadId) throw new Error('wrong_result');
          run.childId = reply.newThreadId; run.sourceThreadId = reply.sourceThreadId; run.jobId = reply.jobId;
        }
        if (reply.status === 'ready') {
          const remaining = Date.parse(reply.expiresAt) - Date.now();
          if (typeof reply.body !== 'string' || !reply.body || new TextEncoder().encode(reply.body).length > 16384 || !Number.isFinite(remaining) || remaining <= 0 || remaining > 16 * 60000)
            throw new Error('invalid_result_body');
          if (!run.completedAt) run.completedAt = Date.now();
          run.state = 'completed'; run.finalReply = reply.body; run.expiresAt = reply.expiresAt;
          clearTimeout(run.expiryTimer);
          run.expiryTimer = setTimeout(() => { if (this.workspaceValid(run)) { run.finalReply = ''; if (run.device === this.sessionDevice) this.projectWorkspaceRun(); } }, remaining);
          await this.completeWorkspaceRun(run);
        } else if (reply.status === 'pending' && !run.confirmedComplete) {
          // A reservation alone cannot prove that the computer received the command.
          if (run.state !== 'recovering') run.state = 'running';
        } else if (['failed', 'interrupted'].includes(reply.status)) run.state = reply.status;
        else if (run.confirmedComplete) { run.state = 'completed'; await this.completeWorkspaceRun(run); }
        else run.state = 'unknown';
        this.saveWorkspaceRuns();
      } catch { if (this.workspaceValid(run)) run.state = 'recovering'; }
      finally {
        run.querying = false;
        if (this.workspaceValid(run)) {
          this.upsertRunRow(run);
          if (this.sessionDevice === run.device) {
            this.projectWorkspaceRun();
            if (terminal(run.state)) this.workspaceComputerState = 'idle';
          }
          if (!terminal(run.state) && run.state !== 'unknown') run.timer = setTimeout(() => this.queryWorkspaceRun(run), 3000);
        }
      }
    },
    async completeWorkspaceRun(run) {
      if (!this.workspaceValid(run)) return;
      const viewing = run.device === this.sessionDevice && (this.sessionSelected === run.childId || this.workspaceView === 'task');
      if (!viewing) { this.workspaceUnread[run.device + ':' + run.childId] = true; return; }
      const sequence = this.workspaceReadSequence, scroll = this.workspaceScrollSnapshot();
      // Retain the result while a read-only refresh is unavailable.
      if (this.workspaceView === 'task') this.workspaceMessages = this.workspaceRunHistory;
      await this.openWorkspaceSession(run.childId, { keepMessages: true, preserveScroll: true });
      if (this.workspaceReadSequence !== sequence + 1 || this.sessionSelected !== run.childId) return;
      if (!run.historyLoaded) this.workspaceHistoryStatus = '回复已收到，正文读取暂不可用；可重新读取，消息不会重发。';
      if (scroll.atBottom) this.scrollWorkspaceBottom(); else { this.workspaceNewReply = true; this.afterWorkspaceRender(() => { if (this.$refs?.workspaceTranscript) this.$refs.workspaceTranscript.scrollTop = scroll.top; }); }
    },
    async checkPhoneSession() {
      this.restoreWorkspaceRuns();
      if (this.workspaceRun) return this.queryWorkspaceRun(this.workspaceRun, true);
      if (this.workspaceServerRequest) {
        const device = this.sessionDevice, epoch = this.sessionEpoch;
        try {
          const reply = await this.workspaceCommand('status', { lookupId: this.workspaceServerRequest, ...(this.workspaceServerJob ? { jobId: this.workspaceServerJob } : {}) });
          if (device !== this.sessionDevice || epoch !== this.sessionEpoch) return;
          this.sessionStatus = ['completed', 'failed', 'interrupted', 'cancelled'].includes(reply.status)
            ? '电脑已确认上一轮结束，请刷新会话后继续。' : '电脑尚未确认上一轮结束，不会自动重发。';
          await this.refreshWorkspaceSessions();
        } catch { this.sessionStatus = '状态暂不可读取，请稍后核查。'; }
        return;
      }
      // A preparation may have lost its receipt; only query its original ID.
      await PhoneSessions.methods.checkPhoneSession.call(this);
    },
    async readPhoneResult() {
      this.restoreWorkspaceRuns();
      if (this.workspaceRun) return this.queryWorkspaceRun(this.workspaceRun);
    },
    showWorkspaceTask() {
      if (!this.workspaceRun) return;
      if (this.workspaceRun.childId) return this.openWorkspaceSession(this.workspaceRun.childId);
      this.workspaceView = 'task'; this.workspaceSidebarOpen = false;
    },
    openCompletedWorkspaceConversation() { if (this.workspaceCompletedChild) return this.openWorkspaceSession(this.workspaceCompletedChild); },
    configureWorkspace() { this.saveWorkspaceDraft(); this.workspaceSetupOpen = true; this.workspaceSidebarOpen = false; },
    async cancelPhoneSession() {
      const run = this.workspaceRun;
      if (!run || terminal(run.state)) return PhoneSessions.methods.cancelPhoneSession.call(this);
      if (run.querying) return;
      run.state = 'unknown'; clearTimeout(run.timer); run.finalReply = ''; this.projectWorkspaceRun();
      try { await this.workspaceCommand('cancel', { lookupId: run.requestId, ...(run.jobId ? { jobId: run.jobId } : {}) }, run.device); }
      catch { /* cancellation without confirmation remains unknown */ }
      this.saveWorkspaceRuns();
    },
    async changeWorkspaceCatalog(action) {
      const row = this.workspaceSelectedRow;
      if (!row || !(row.kind === 'derived' || row.parentThreadId) || this.workspaceReadBusy) return;
      const name = this.workspaceRenameText.trim();
      if (action === 'rename' && (!name || name.length > 56)) { this.sessionStatus = '名称请填写 1–56 个字符。'; return; }
      const device = this.sessionDevice, id = row.sourceThreadId, epoch = this.sessionEpoch;
      const bytes = new TextEncoder().encode(JSON.stringify({ action, id, ...(action === 'rename' ? { name } : {}) }));
      const cursor = 'workspace:' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      this.workspaceReadBusy = true;
      try {
        const reply = await this.workspaceCommand('list', { cursor });
        if (device !== this.sessionDevice || epoch !== this.sessionEpoch) return;
        if (reply.status !== 'catalog_updated' || reply.data?.sourceThreadId !== id) throw new Error('catalog_refused');
        if (action === 'remove') {
          this.workspaceRemoved[device + ':' + id] = true;
          this.sessionRows = this.sessionRows.filter(item => item.sourceThreadId !== id);
          delete this.workspaceDrafts[device + ':' + id];
          if (this.sessionSelected === id) { this.workspaceReadSequence++; this.sessionSelected = ''; this.sessionPreview = null; this.sessionTask = ''; this.clearWorkspaceBody(true); }
          this.rememberWorkspace(); this.sessionStatus = '已从面板移除，电脑会话和执行记录保留。';
        } else { this.sessionRows = this.sessionRows.map(item => item.sourceThreadId === id ? { ...item, name: reply.data.name } : item); this.sessionStatus = '名称已保存到电脑。'; }
        this.workspaceRenameOpen = false;
      } catch { if (device === this.sessionDevice && epoch === this.sessionEpoch) this.sessionStatus = '修改未获确认，请刷新列表核对，不会删除电脑会话。'; }
      finally { if (device === this.sessionDevice && epoch === this.sessionEpoch) this.workspaceReadBusy = false; }
    },
    workspaceRowDetail(row) {
      const state = ({ draft: '草稿', idle: '空闲', unavailable: '暂不可用', running: '处理中', claimed: '待核查', unknown: '待核查', completed: '已完成', failed: '失败', interrupted: '已中断' })[row.state] || '';
      const date = row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return [state, date].filter(Boolean).join(' · ') || '点击查看正文';
    },
    afterWorkspaceRender(callback) { if (this.$nextTick) this.$nextTick(callback); else callback(); },
    workspaceScrollSnapshot() {
      const element = this.$refs?.workspaceTranscript;
      return element ? { top: element.scrollTop, height: element.scrollHeight, atBottom: element.scrollHeight - element.scrollTop - element.clientHeight < 80 }
        : { top: 0, height: 0, atBottom: this.workspaceAtBottom };
    },
    onWorkspaceScroll() {
      this.workspaceAtBottom = this.workspaceScrollSnapshot().atBottom;
      if (this.workspaceAtBottom) this.workspaceNewReply = false;
    },
    scrollWorkspaceBottom() {
      this.workspaceAtBottom = true; this.workspaceNewReply = false;
      this.afterWorkspaceRender(() => { const element = this.$refs?.workspaceTranscript; if (element) element.scrollTop = element.scrollHeight; });
    },
    resizeWorkspaceInput(event) {
      this.saveWorkspaceDraft();
      const element = event.target; element.style.height = 'auto'; element.style.height = Math.min(180, Math.max(64, element.scrollHeight)) + 'px';
    },
    async copyWorkspaceText(text) {
      try { await navigator.clipboard.writeText(text); this.workspaceCopyStatus = '已复制'; }
      catch { this.workspaceCopyStatus = '复制不可用，请长按选择正文复制。'; }
    },
    onWorkspaceBodyClick(event) {
      const button = event.target.closest?.('[data-copy-code]');
      if (button) this.copyWorkspaceText(button.parentElement.querySelector('code').textContent);
    },
    renderConversationMarkdown(value) {
      // The base renderer escapes HTML. Tables and ordered lists use the same fixed-tag policy.
      const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
      const inline = text => base.renderConversationMarkdown.call(this, text).replace(/^<p>|<\/p>$/g, '');
      const blocks = []; let regular = [], fenced = false;
      const flush = () => { if (regular.length) { blocks.push(base.renderConversationMarkdown.call(this, regular.join('\n'))); regular = []; } };
      const cells = line => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*```/.test(line)) { fenced = !fenced; regular.push(line); continue; }
        if (fenced) { regular.push(line); continue; }
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
          flush(); const header = cells(line); i++;
          const rows = [];
          while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
          blocks.push('<div class="conversation-table"><table><thead><tr>' + header.map(cell => '<th>' + inline(cell) + '</th>').join('') + '</tr></thead><tbody>' +
            rows.map(row => '<tr>' + header.map((_, j) => '<td>' + inline(row[j] || '') + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>');
        } else if (/^\s*\d+[.)]\s+/.test(line)) {
          flush(); const items = [line]; while (i + 1 < lines.length && /^\s*\d+[.)]\s+/.test(lines[i + 1])) items.push(lines[++i]);
          const start = Number(items[0].trim().match(/^\d+/)[0]);
          blocks.push(`<ol start="${Number.isSafeInteger(start) ? start : 1}">` + items.map(item => '<li>' + inline(item.replace(/^\s*\d+[.)]\s+/, '')) + '</li>').join('') + '</ol>');
        } else regular.push(line);
      }
      flush();
      return blocks.join('').replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g,
        (_, code) => '<div class="conversation-code"><button type="button" data-copy-code aria-label="复制代码">复制代码</button><pre><code>' + code + '</code></pre></div>');
    },
    installWorkspaceLifecycle() {
      if (this.workspaceLifecycleReady) return;
      this.workspaceLifecycleReady = true;
      const updateViewport = () => {
        const viewport = window.visualViewport;
        const height = viewport?.height || window.innerHeight;
        document.documentElement?.style.setProperty('--workspace-viewport', height + 'px');
        const keyboard = !!viewport && window.innerHeight - viewport.height > 120;
        document.documentElement?.classList.toggle('workspace-keyboard', keyboard && this.tab === 'task');
        if (this.workspaceAtBottom) this.scrollWorkspaceBottom();
      };
      window.visualViewport?.addEventListener('resize', updateViewport);
      window.visualViewport?.addEventListener('scroll', updateViewport);
      window.addEventListener('resize', updateViewport); updateViewport();
      const resume = () => {
        if (document.visibilityState === 'hidden') return;
        for (const run of Object.values(this.workspaceRuns)) if (!terminal(run.state)) this.queryWorkspaceRun(run, true);
      };
      document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume);
      const tick = () => { this.workspaceClock = Date.now(); if (this.signedIn !== false) this.workspaceClockTimer = setTimeout(tick, 1000); };
      tick();
    },
    clearWorkspaceRuntime() {
      for (const run of Object.values(this.workspaceRuns)) { clearTimeout(run.timer); clearTimeout(run.expiryTimer); }
      clearTimeout(this.workspaceClockTimer); this.workspaceClockTimer = null;
      this.workspaceRuns = {}; this.workspaceDrafts = {}; this.workspaceUnread = {}; this.workspaceRunHistory = []; this.workspaceRemoved = {}; this.workspacePreparedDrafts = {};
      this.workspaceSentPrompt = ''; this.workspaceOwner = ''; this.workspaceReadSequence++;
      localStorage.removeItem('nc_workspace_runs');
    }
  });
})();
