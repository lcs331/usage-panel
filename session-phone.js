// Explicit phone workflow. Durable browser state contains IDs only, never task/history/reply.
globalThis.PhoneSessions = {
  data() {
    return {
      sessionDevices: [], sessionDevice: '', sessionRows: [], sessionCursor: null,
      sessionSelected: '', sessionPreview: null, sessionDraft: null, sessionCwd: '', sessionTask: '',
      sessionCwdConsent: false, sessionContextConsent: false, sessionBusy: false, sessionCancelling: false,
      sessionSubmitted: false, sessionStatus: '选择电脑，再明确读取会话列表。',
      sessionLastRequest: '', sessionLastOperation: '', sessionCanRecover: false, sessionGeneration: 0,
      sessionResultRequest: '', sessionFinalReply: '', sessionResultExpires: '', sessionResultTruncated: false,
      sessionResultTimer: null
    };
  },
  methods: {
    phoneRecord(key) {
      try {
        const value = JSON.parse(localStorage.getItem(key));
        return value?.owner === this.userId() && value.device === this.sessionDevice ? value : null;
      } catch { return null; }
    },
    recoverablePhoneReceipt() {
      const saved = this.phoneRecord('nc_session_receipt');
      if (saved?.operation === 'list' && Number.isFinite(saved.at) && Date.now() - saved.at >= 120000) {
        this.forgetPhoneRequest(saved.requestId);
        return null;
      }
      return saved;
    },
    resetPhoneSessions() {
      clearTimeout(this.sessionResultTimer); this.sessionResultTimer = null;
      this.sessionGeneration++;
      this.sessionRows = []; this.sessionCursor = null; this.sessionSelected = '';
      this.sessionPreview = null; this.sessionDraft = null; this.sessionCwd = ''; this.sessionTask = '';
      this.sessionCwdConsent = false; this.sessionContextConsent = false;
      this.sessionSubmitted = false; this.sessionBusy = false; this.sessionCancelling = false;
      this.sessionFinalReply = ''; this.sessionResultExpires = ''; this.sessionResultTruncated = false;
      const saved = this.recoverablePhoneReceipt();
      this.sessionLastRequest = saved?.requestId || ''; this.sessionLastOperation = saved?.operation || '';
      this.sessionResultRequest = this.phoneRecord('nc_session_result')?.requestId || '';
      this.sessionCanRecover = !!saved;
      this.sessionStatus = '选择电脑，再明确读取会话列表。';
    },
    async loadSessionDevices() {
      if (this.sessionBusy) return;
      this.sessionBusy = true;
      const epoch = this.sessionEpoch;
      try {
        const response = await this.sessionFetch(SUPABASE + '/rest/v1/devices?select=id,name,last_seen&owner=eq.' +
          encodeURIComponent(this.userId()) + '&revoked_at=is.null&order=last_seen.desc', { headers: this.headers() });
        const rows = await response.json();
        if (epoch !== this.sessionEpoch) return;
        if (!Array.isArray(rows)) throw new Error('devices_unavailable');
        this.sessionDevices = rows;
        if (!rows.some(d => d.id === this.sessionDevice)) this.sessionDevice = '';
        this.sessionCanRecover = !!this.recoverablePhoneReceipt();
        this.sessionResultRequest = this.phoneRecord('nc_session_result')?.requestId || '';
        this.sessionStatus = rows.length ? '请选择电脑；不会自动读取会话或正文。' : '没有可用设备，请先绑定并启动测试 UsageAgent。';
      } catch { if (epoch === this.sessionEpoch) this.sessionStatus = '设备列表未读取，请检查连接。'; }
      finally { if (epoch === this.sessionEpoch) this.sessionBusy = false; }
    },
    selectPhoneSession(id) {
      if (this.sessionBusy || this.sessionCanRecover) return;
      this.clearPhoneResult();
      this.sessionSelected = id; this.sessionPreview = null; this.sessionDraft = null; this.sessionFinalReply = '';
      this.sessionCwdConsent = false; this.sessionContextConsent = false; this.sessionSubmitted = false;
      this.sessionStatus = '已选择来源；点击“读取预览”才请求内容摘录。';
    },
    phoneCwdChanged() {
      this.sessionDraft = null; this.sessionCwdConsent = false; this.sessionContextConsent = false;
    },
    async sessionFetch(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          const error = new Error('session_http_error'); error.status = response.status; throw error;
        }
        return response;
      } finally { clearTimeout(timer); }
    },
    async sessionRpc(name, body) {
      const response = await this.sessionFetch(SUPABASE + '/rest/v1/rpc/' + name, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body)
      });
      return response.json();
    },
    rememberPhoneReceipt(requestId, operation) {
      localStorage.setItem('nc_session_receipt', JSON.stringify({ owner: this.userId(), device: this.sessionDevice,
        requestId, operation, at: Date.now() }));
      this.sessionLastRequest = requestId; this.sessionLastOperation = operation;
    },
    rememberPhoneResult(requestId) {
      localStorage.setItem('nc_session_result', JSON.stringify({ owner: this.userId(), device: this.sessionDevice, requestId }));
      this.sessionResultRequest = requestId;
    },
    clearPhoneResult() {
      clearTimeout(this.sessionResultTimer); this.sessionResultTimer = null;
      this.sessionFinalReply = ''; this.sessionResultExpires = ''; this.sessionResultTruncated = false;
      if (this.phoneRecord('nc_session_result')) localStorage.removeItem('nc_session_result');
      this.sessionResultRequest = '';
    },
    forgetPhoneRequest(requestId) {
      if (this.phoneRecord('nc_session_receipt')?.requestId === requestId) localStorage.removeItem('nc_session_receipt');
      if (this.phoneRecord('nc_session_result')?.requestId === requestId) {
        localStorage.removeItem('nc_session_result'); this.sessionResultRequest = '';
      }
      this.sessionLastRequest = ''; this.sessionLastOperation = '';
    },
    async pollSessionReceipt(requestId, device, epoch, generation, seconds = 35) {
      for (let i = 0; i < seconds; i++) {
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) throw new Error('session_changed');
        const rows = await this.sessionRpc('session_command_receipt', { p_device: device, p_request: requestId });
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) throw new Error('session_changed');
        const row = rows?.[0];
        if (row && (row.status === 'done' || row.status === 'failed')) {
          if (!row.result) return { v: 1, status: 'unknown', code: 'receipt_missing' };
          const reply = JSON.parse(row.result);
          if (reply.v !== 1 || !reply.status) throw new Error('invalid_receipt');
          return reply;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error('receipt_timeout');
    },
    async phoneSessionRequest(operation, options = {}) {
      if (this.sessionBusy || !this.sessionDevice || (this.sessionCanRecover && operation !== 'status')) return;
      if (operation === 'execute' && this.sessionSubmitted) return;
      if (['list', 'preview', 'prepare'].includes(operation)) this.clearPhoneResult();
      const epoch = this.sessionEpoch, generation = this.sessionGeneration, device = this.sessionDevice;
      const requestId = crypto.randomUUID();
      const payload = { requestId, operation, relayVersion: 1, expiresAt: new Date(Date.now() + 120000).toISOString(), ...options };
      let remembered = false, accepted = false, lookupResult = false;
      this.sessionBusy = true; this.sessionStatus = '等待电脑回执…';
      if (operation === 'execute') this.sessionSubmitted = true;
      try {
        // Persist correlation BEFORE sending: a lost enqueue response must remain recoverable.
        this.rememberPhoneReceipt(requestId, operation); remembered = true;
        if (operation === 'execute') this.rememberPhoneResult(requestId);
        await this.sessionRpc('enqueue_session_request', { p_device: device, p_payload: payload }); accepted = true;
        const reply = await this.pollSessionReceipt(requestId, device, epoch, generation);
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
        this.applyPhoneReceipt(reply, operation);
        this.sessionCanRecover = operation !== 'list' && (reply.status === 'unknown' || reply.status === 'disconnected');
        if (operation === 'list' && (reply.status === 'unknown' || reply.status === 'disconnected')) {
          this.sessionStatus = '未收到会话列表，请重新读取。';
        }
        if (!this.sessionCanRecover && reply.status !== 'running') localStorage.removeItem('nc_session_receipt');
        lookupResult = operation === 'execute';
      } catch (error) {
        if (epoch === this.sessionEpoch && generation === this.sessionGeneration) {
          if (!remembered || (!accepted && [400, 401, 403, 404, 409, 422].includes(error?.status))) {
            this.forgetPhoneRequest(requestId); this.sessionCanRecover = false; this.sessionSubmitted = false;
            this.sessionStatus = '请求未被接收，请修改或重新登录后提交。';
          } else if (operation === 'list') {
            this.forgetPhoneRequest(requestId);
            this.sessionCanRecover = false;
            this.sessionStatus = '读取会话列表超时，请重新读取。';
          } else {
            this.sessionCanRecover = true;
            this.sessionStatus = '是否已执行尚不确定；请查询结果或取消，不能重复提交。';
          }
        }
      } finally { if (epoch === this.sessionEpoch && generation === this.sessionGeneration) this.sessionBusy = false; }
      if (lookupResult && epoch === this.sessionEpoch && generation === this.sessionGeneration) await this.readPhoneResult(35);
    },
    applyPhoneReceipt(reply, operation) {
      const data = reply.data || {};
      const labels = { listed: '列表已读取，尚未读取历史。', previewed: '有限脱敏摘录已读取，完整历史仍在电脑。',
        draft: '独立草稿已创建，尚未调用模型。', running: '电脑正在执行；完成后可在这里查看最终回复。',
        completed: '任务完成，正在查询该次最终回复。', failed: '请求失败或被拒绝。',
        cancelled: '已取消未执行的草稿，保留已有新会话。', expired: '请求或草稿已过期，不会自动执行。',
        disconnected: '本地连接失效；核对新会话，不能恢复提交。', unknown: '结果未知；核对新会话，不要重复提交。',
        disabled: '电脑未启用手机会话功能。', interrupted: '本次新回合已中断。' };
      this.sessionStatus = labels[reply.status] || '未知状态，请到电脑核对。';
      if (reply.code) this.sessionStatus += ' (' + reply.code + ')';
      if (reply.status === 'listed') { this.sessionRows = data.sessions || []; this.sessionCursor = data.nextCursor || null; }
      if (reply.status === 'previewed') {
        this.sessionPreview = data; this.sessionCwd = data.cwd; this.sessionDraft = null;
        this.sessionCwdConsent = false; this.sessionContextConsent = false; this.sessionSubmitted = false;
      }
      if (data.newThreadId || data.jobId) this.sessionDraft = { ...this.sessionDraft, ...data, state: reply.status };
      if (reply.status === 'draft') { this.sessionContextConsent = false; this.sessionSubmitted = false; }
      if (operation === 'prepare' && reply.status !== 'draft') this.sessionPreview = null;
    },
    listPhoneSessions(next = false) {
      if (this.sessionCanRecover || this.sessionBusy) return;
      this.sessionPreview = null; this.sessionDraft = null; this.sessionSelected = ''; this.sessionFinalReply = '';
      this.sessionSubmitted = false; this.sessionCwdConsent = false; this.sessionContextConsent = false;
      return this.phoneSessionRequest('list', next && this.sessionCursor ? { cursor: this.sessionCursor } : {});
    },
    previewPhoneSession() {
      if (!this.sessionSelected || this.sessionCanRecover || this.sessionBusy) return;
      this.sessionPreview = null; this.sessionDraft = null;
      return this.phoneSessionRequest('preview', { sourceThreadId: this.sessionSelected });
    },
    preparePhoneSession() {
      if (!this.sessionPreview || !this.sessionCwdConsent || !this.sessionCwd.trim() || this.sessionCanRecover) return;
      return this.phoneSessionRequest('prepare', { sourceThreadId: this.sessionPreview.sourceThreadId,
        previewId: this.sessionPreview.previewId, cwd: this.sessionCwd.trim(), confirmSharedCwd: true });
    },
    executePhoneSession() {
      if (!this.sessionDraft || this.sessionDraft.state !== 'draft' || !this.sessionContextConsent || !this.sessionTask.trim() || this.sessionCanRecover) return;
      this.sessionFinalReply = '';
      return this.phoneSessionRequest('execute', { sourceThreadId: this.sessionDraft.sourceThreadId, jobId: this.sessionDraft.jobId,
        cwd: this.sessionDraft.cwd, prompt: this.sessionTask.trim(), confirmContext: true });
    },
    async readPhoneResult(seconds = 1) {
      if (this.sessionBusy) return;
      const saved = this.phoneRecord('nc_session_result');
      if (!saved) { this.sessionStatus = '请用派单账号选择原测试电脑，再查询该次结果。'; return; }
      const epoch = this.sessionEpoch, generation = this.sessionGeneration;
      this.sessionBusy = true; this.sessionFinalReply = '';
      try {
        for (let i = 0; i < seconds; i++) {
          const reply = await this.sessionRpc('read_session_result', { p_device: saved.device, p_request: saved.requestId });
          if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
          if (reply?.v !== 1 || !['ready', 'pending', 'failed', 'interrupted', 'unknown', 'unavailable', 'expired'].includes(reply.status)) throw new Error('invalid_result');
          this.sessionResultRequest = saved.requestId; this.sessionResultExpires = reply.expiresAt || '';
          this.sessionResultTruncated = reply.truncated === true;
          if (reply.newThreadId) this.sessionDraft = { ...(this.sessionDraft?.newThreadId === reply.newThreadId ? this.sessionDraft : {}),
            sourceThreadId: reply.sourceThreadId, newThreadId: reply.newThreadId,
            jobId: reply.jobId, state: reply.status === 'ready' ? 'completed' : reply.status };
          this.sessionCanRecover = reply.status === 'pending' || reply.status === 'unknown';
          if (reply.status === 'ready') {
            const remaining = Date.parse(reply.expiresAt) - Date.now();
            if (typeof reply.body !== 'string' || new TextEncoder().encode(reply.body).length > 16384 ||
                !Number.isFinite(remaining) || remaining <= 0 || remaining > 16 * 60000) throw new Error('invalid_result');
            this.sessionFinalReply = reply.body;
            clearTimeout(this.sessionResultTimer);
            this.sessionResultTimer = setTimeout(() => {
              if (epoch === this.sessionEpoch && generation === this.sessionGeneration && this.sessionResultRequest === saved.requestId) {
                this.sessionFinalReply = ''; this.sessionStatus = '结果已过期，正文已从页面清除。';
              }
            }, remaining);
            this.sessionStatus = this.sessionResultTruncated ? '任务完成；回复超过 16 KiB，仅展示前缀。' : '任务完成，以下为该次最终助手回复。';
          } else {
            const labels = { pending: '尚无最终回复；可稍后查询，不会再次派单。', failed: '任务失败，没有可展示的最终回复。',
              interrupted: '任务已中断，没有最终回复。', unknown: '执行结果未知，不能重复派单。',
              unavailable: '最终回复不可用或被敏感内容检查阻止，请在电脑核对。', expired: '结果已过期，正文不可用；不会重新执行。' };
            this.sessionStatus = labels[reply.status];
          }
          if (reply.status !== 'pending') {
            if (this.phoneRecord('nc_session_receipt')?.requestId === saved.requestId) localStorage.removeItem('nc_session_receipt');
            return;
          }
          if (i + 1 < seconds) await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch {
        if (epoch === this.sessionEpoch && generation === this.sessionGeneration) {
          this.sessionCanRecover = true;
          this.sessionStatus = '结果暂不可读取：请核对派单账号、原电脑、网络及有效期。不会重发任务。';
        }
      } finally { if (epoch === this.sessionEpoch && generation === this.sessionGeneration) this.sessionBusy = false; }
    },
    async checkPhoneSession() {
      if (this.sessionBusy) return;
      if (this.phoneRecord('nc_session_result')) return this.readPhoneResult();
      const saved = this.phoneRecord('nc_session_receipt');
      if (!saved) { this.sessionStatus = '没有属于当前账号和电脑的恢复记录。'; return; }
      const epoch = this.sessionEpoch, generation = this.sessionGeneration;
      this.sessionBusy = true;
      try {
        const reply = await this.pollSessionReceipt(saved.requestId, saved.device, epoch, generation, 1);
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
        this.applyPhoneReceipt(reply, saved.operation); this.sessionCanRecover = reply.status === 'unknown';
        if (saved.operation === 'list' && this.sessionCanRecover) {
          this.sessionStatus = '未收到会话列表，请重新读取。';
          this.forgetPhoneRequest(saved.requestId);
          this.sessionCanRecover = false;
        }
        if (!this.sessionCanRecover && reply.status !== 'running') localStorage.removeItem('nc_session_receipt');
      } catch {
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
        if (saved.operation === 'list') {
          this.forgetPhoneRequest(saved.requestId);
          this.sessionCanRecover = false;
          this.sessionStatus = '读取会话列表超时，请重新读取。';
        } else {
          this.sessionStatus = '尚无确定回执，请稍后查询或取消。';
        }
      }
      finally { if (epoch === this.sessionEpoch && generation === this.sessionGeneration) this.sessionBusy = false; }
    },
    async cancelPhoneSession() {
      if (this.sessionCancelling || !this.sessionDevice || (!this.sessionDraft && !this.sessionLastRequest && !this.sessionResultRequest)) return;
      clearTimeout(this.sessionResultTimer); this.sessionResultTimer = null;
      this.sessionFinalReply = ''; this.sessionResultExpires = ''; this.sessionResultTruncated = false;
      this.sessionCancelling = true;
      const epoch = this.sessionEpoch, device = this.sessionDevice;
      this.sessionGeneration++; const generation = this.sessionGeneration;
      const requestId = crypto.randomUUID();
      const options = this.sessionDraft?.jobId ? { jobId: this.sessionDraft.jobId } : { lookupId: this.sessionLastRequest || this.sessionResultRequest };
      const previous = localStorage.getItem('nc_session_receipt');
      let accepted = false;
      this.sessionBusy = true;
      try {
        this.rememberPhoneReceipt(requestId, 'cancel');
        await this.sessionRpc('enqueue_session_request', { p_device: device, p_payload: { requestId, operation: 'cancel', relayVersion: 1,
          expiresAt: new Date(Date.now() + 120000).toISOString(), ...options } }); accepted = true;
        const reply = await this.pollSessionReceipt(requestId, device, epoch, generation);
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
        this.applyPhoneReceipt(reply, 'cancel'); this.sessionCanRecover = reply.status === 'unknown';
        if (!this.sessionCanRecover) localStorage.removeItem('nc_session_receipt');
      } catch (error) {
        if (epoch !== this.sessionEpoch || generation !== this.sessionGeneration) return;
        if (!accepted && [400, 401, 403, 404, 409, 422].includes(error?.status)) {
          if (previous) localStorage.setItem('nc_session_receipt', previous); else localStorage.removeItem('nc_session_receipt');
          this.sessionCanRecover = !!previous; this.sessionStatus = '取消请求被拒绝，请核对原请求状态。';
        } else {
          this.sessionStatus = '取消未获得回执，不能承诺已停止；请继续查询。'; this.sessionCanRecover = true;
        }
      } finally {
        if (epoch === this.sessionEpoch && generation === this.sessionGeneration) { this.sessionBusy = false; this.sessionCancelling = false; }
      }
    }
  }
};
