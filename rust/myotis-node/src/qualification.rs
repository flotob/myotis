//! Disposable-host fixture only; absent unless `qualification` is explicit.
//!
//! Observes the scheduler's own request-table flag. It does NOT retrieve the
//! Submission through TLS, create an Operation, or qualify reader/EVM/network
//! cancellation. Production scheduler/admission function bodies are untouched.
use super::*;
use napi_derive::napi;
use std::sync::atomic::AtomicU64;
use std::sync::OnceLock;

const BASE: &str = "02a183d86474a263cf8e85e5c2c2399672645535";
const FIXTURE_SOURCE: &str = env!("MYOTIS_QUALIFICATION_SOURCE");
const POLL: Duration = Duration::from_millis(5);
const MAX_GATES: usize = 64;

struct Observation {
    entries: u32,
    exits: u32,
    request_id: u64,
    thread: String,
    terminal: &'static str,
    entered_us: u128,
    exited_us: u128,
}
struct Gate {
    created: Instant,
    release: AtomicBool,
    observation: Mutex<Observation>,
}
static GATES: OnceLock<Mutex<HashMap<String, Arc<Gate>>>> = OnceLock::new();
static GATE_TOTAL: AtomicU64 = AtomicU64::new(0);

fn gates() -> &'static Mutex<HashMap<String, Arc<Gate>>> {
    GATES.get_or_init(|| Mutex::new(HashMap::new()))
}
fn gate(id: &str) -> Result<Arc<Gate>> {
    gates()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .cloned()
        .ok_or_else(|| Error::from_reason("unknown qualification gate"))
}

#[napi(js_name = "qualificationInfo")]
pub fn info(env: &Env) -> String {
    // Observation alone MUST NOT initialize an environment/allocate workers.
    let state = ENVS.with(|envs| envs.borrow().get(&(env.raw() as usize)).cloned());
    let (pending, requests, active, next_id, poisoned, closing) = state.map_or(
        (0, 0, 0, 0, false, false),
        |state| {
            let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            let active = inner
                .handles
                .iter()
                .filter(|handle| inner.queue.is_active(**handle))
                .count();
            (
                inner.pending,
                inner.requests.len(),
                active,
                inner.next_id,
                inner.poisoned,
                inner.closing,
            )
        },
    );
    format!(
        r#"{{"fixture":true,"base":"{BASE}","fixtureSource":"{FIXTURE_SOURCE}","operationBridge":false,"pollMs":5,"liveWorkers":{},"pending":{pending},"requests":{requests},"active":{active},"queued":{},"nextId":{next_id},"poisoned":{poisoned},"closing":{closing},"gates":{}}}"#,
        LIVE_WORKERS.load(Ordering::Acquire),
        requests.saturating_sub(active),
        GATE_TOTAL.load(Ordering::Acquire),
    )
}

#[napi(js_name = "qualificationSnapshot")]
pub fn snapshot(id: String) -> Result<String> {
    let gate = gate(&id)?;
    let o = gate.observation.lock().unwrap_or_else(|e| e.into_inner());
    // IDs are validated ASCII; thread is one of the two fixed scheduler names.
    Ok(format!(
        r#"{{"id":"{id}","entries":{},"exits":{},"requestId":{},"thread":"{}","terminal":"{}","enteredUs":{},"exitedUs":{},"released":{}}}"#,
        o.entries, o.exits, o.request_id, o.thread, o.terminal, o.entered_us,
        o.exited_us, gate.release.load(Ordering::Acquire),
    ))
}

#[napi(js_name = "qualificationRelease")]
pub fn release(id: String) -> Result<()> {
    gate(&id)?.release.store(true, Ordering::Release);
    Ok(())
}

#[napi(js_name = "qualificationGate")]
pub fn submit_gate<'env>(
    env: &'env Env,
    handle: i64,
    id: String,
    hold_ms: u32,
    finite_completion: bool,
) -> Result<Object<'env>> {
    if id.is_empty()
        || id.len() > 64
        || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        || !(1..=10_000).contains(&hold_ms)
    {
        return Err(Error::from_reason("invalid finite qualification gate"));
    }
    if !owns(env, handle) {
        return Err(Error::from_reason("qualification requires an owned created handle"));
    }
    let gate = Arc::new(Gate {
        created: Instant::now(),
        release: AtomicBool::new(false),
        observation: Mutex::new(Observation {
            entries: 0,
            exits: 0,
            request_id: 0,
            thread: String::new(),
            terminal: "not_entered",
            entered_us: 0,
            exited_us: 0,
        }),
    });
    {
        let mut registry = gates().lock().unwrap_or_else(|e| e.into_inner());
        if registry.len() >= MAX_GATES || registry.contains_key(&id) {
            return Err(Error::from_reason("qualification gate registry full or duplicate id"));
        }
        registry.insert(id, Arc::clone(&gate));
        GATE_TOTAL.fetch_add(1, Ordering::Release);
    }
    let owner = Arc::downgrade(&state(env)?);
    submit(env, handle, move || {
        // Per-handle FIFO and one executing job mean the smallest outstanding
        // ID is THIS job. finish removes the previous ID before releasing its
        // active slot. The Arc below is the exact flag also cloned into that
        // Job's Submission; no synthetic cancellation token is introduced.
        // The TLS submitted() -> Operation bridge remains explicitly untested.
        let token = owner.upgrade().and_then(|state| {
            let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
            if !inner.queue.is_active(handle) {
                return None;
            }
            let (id, (_, token)) = inner.requests.iter()
                .filter(|(_, (h, _))| *h == handle)
                .min_by_key(|(id, _)| **id)?;
            if token.load(Ordering::Acquire) {
                return None;
            }
            Some((*id, Arc::clone(token)))
        });
        let Some((request_id, cancelled)) = token else {
            return r#"{"error":"qualification token missing"}"#.to_string();
        };
        if cancelled.load(Ordering::Acquire) {
            return r#"{"error":"qualification token already cancelled at acquisition"}"#.to_string();
        }
        let thread = std::thread::current().name().unwrap_or("").to_string();
        if thread != "myotis-node-0" && thread != "myotis-node-1" {
            return r#"{"error":"qualification wrong worker"}"#.to_string();
        }
        {
            let mut o = gate.observation.lock().unwrap_or_else(|e| e.into_inner());
            o.entries += 1;
            o.request_id = request_id;
            o.thread = thread;
            o.terminal = "active";
            o.entered_us = gate.created.elapsed().as_micros();
        }
        let started = Instant::now();
        let terminal = loop {
            if cancelled.load(Ordering::Acquire) {
                break "cancelled";
            }
            if gate.release.load(Ordering::Acquire) {
                break "released";
            }
            if started.elapsed() >= Duration::from_millis(u64::from(hold_ms)) {
                break if finite_completion { "finite" } else { "safety_limit" };
            }
            std::thread::sleep(POLL);
        };
        {
            let mut o = gate.observation.lock().unwrap_or_else(|e| e.into_inner());
            o.exits += 1;
            o.terminal = terminal;
            o.exited_us = gate.created.elapsed().as_micros();
        }
        match terminal {
            "cancelled" => r#"{"error":"request cancelled"}"#.to_string(),
            "safety_limit" => r#"{"error":"qualification safety limit"}"#.to_string(),
            _ => format!(r#"{{"qualification":"{terminal}"}}"#),
        }
    })
}
