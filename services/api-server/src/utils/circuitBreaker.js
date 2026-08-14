/**
 * Circuit Breaker — protects against cascading failures when calling
 * external services (storage nodes, metadata service).
 *
 * States:
 *   CLOSED  → All requests pass through (normal operation)
 *   OPEN    → All requests fail immediately (service is down)
 *   HALF_OPEN → One probe request allowed to test recovery
 *
 * Usage:
 *   const breaker = new CircuitBreaker('storage-node-1', { failureThreshold: 3 });
 *   const result = await breaker.execute(() => axios.get(...));
 */

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

class CircuitBreaker {
  /**
   * @param {string} name - Service identifier (for logging)
   * @param {Object} opts
   * @param {number} opts.failureThreshold - Failures before opening (default 3)
   * @param {number} opts.resetTimeout - Ms before trying half-open (default 30000)
   * @param {number} opts.monitorWindow - Ms window for failure counting (default 60000)
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.failureThreshold = opts.failureThreshold || 3;
    this.resetTimeout = opts.resetTimeout || 30000; // 30s
    this.monitorWindow = opts.monitorWindow || 60000; // 1 min
  }

  /**
   * Execute a function with circuit breaker protection.
   * @param {Function} fn - Async function to execute
   * @returns {Promise<*>} - Result of fn
   * @throws {Error} - If circuit is open or fn fails
   */
  async execute(fn) {
    if (this.state === STATES.OPEN) {
      // Check if reset timeout has passed → transition to HALF_OPEN
      if (Date.now() - this.lastFailureTime >= this.resetTimeout) {
        this.state = STATES.HALF_OPEN;
        console.log(`⚡ Circuit [${this.name}]: HALF_OPEN — allowing probe request`);
      } else {
        throw new CircuitBreakerError(
          `Circuit [${this.name}] is OPEN. Service unavailable.`,
          this.name
        );
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      // Probe succeeded → close circuit
      console.log(`⚡ Circuit [${this.name}]: CLOSED — service recovered`);
    }
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.successCount++;
  }

  _onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === STATES.HALF_OPEN) {
      // Probe failed → back to OPEN
      this.state = STATES.OPEN;
      console.log(`⚡ Circuit [${this.name}]: OPEN — probe failed`);
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.state = STATES.OPEN;
      console.warn(`⚡ Circuit [${this.name}]: OPEN — ${this.failureCount} failures exceeded threshold`);
    }
  }

  /**
   * Get current circuit status.
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Force reset the circuit breaker.
   */
  reset() {
    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;
    console.log(`⚡ Circuit [${this.name}]: manually RESET`);
  }
}

class CircuitBreakerError extends Error {
  constructor(message, serviceName) {
    super(message);
    this.name = 'CircuitBreakerError';
    this.serviceName = serviceName;
    this.isCircuitOpen = true;
  }
}

// ── Circuit Breaker Registry ─────────────────────────────────
// Shared instances by service name
const breakers = new Map();

function getBreaker(name, opts) {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(name, opts));
  }
  return breakers.get(name);
}

function getAllStatus() {
  const status = {};
  for (const [name, breaker] of breakers) {
    status[name] = breaker.getStatus();
  }
  return status;
}

module.exports = { CircuitBreaker, CircuitBreakerError, getBreaker, getAllStatus, STATES };
