'use strict';

// Lazy-load transaction context to avoid bundling issues
let transactionCtx = null;

/**
 * Gets the transaction context for proper emit timing
 * @returns {object} Transaction context with get() and onCommit() methods
 */
function getTransactionCtx() {
	if (!transactionCtx) {
		try {
			transactionCtx = require('@strapi/database/dist/transaction-context').transactionCtx;
		} catch (error) {
			console.warn('[@strapi-community/plugin-io] Unable to access transaction context:', error.message);
			transactionCtx = { get: () => null, onCommit: () => {} }; // Fallback noop
		}
	}
	return transactionCtx;
}

/**
 * Schedules a callback to run after the current transaction commits
 * @param {Function} callback - The callback to execute
 * @param {number} delay - Optional delay in ms after commit
 */
function scheduleAfterTransaction(callback, delay = 0) {
	const runner = () => setTimeout(callback, delay);
	const ctx = getTransactionCtx();
	if (ctx.get()) {
		ctx.onCommit(runner);
	} else {
		runner();
	}
}

/**
 * Normalizes populate configuration to Strapi format
 * Supports: '*', true, ['field1', 'field2'], { field: options }
 * @param {string|boolean|array|object} config - The populate configuration
 * @returns {string|object} Normalized populate value for Strapi Document Service
 */
function normalizePopulate(config) {
	if (config === '*' || config === true) {
		return '*';
	}
	
	if (Array.isArray(config)) {
		// Convert array to object format: ['author', 'category'] -> { author: true, category: true }
		return config.reduce((acc, field) => {
			acc[field] = true;
			return acc;
		}, {});
	}
	
	if (typeof config === 'object' && config !== null) {
		return config;
	}
	
	return undefined;
}

/**
 * Fetches an entity with populate configuration
 * @param {object} strapi - Strapi instance
 * @param {string} uid - Content type UID
 * @param {string} documentId - Document ID to fetch
 * @param {*} populateConfig - Populate configuration
 * @returns {Promise<object|null>} The populated entity or null
 */
async function fetchWithPopulate(strapi, uid, documentId, populateConfig) {
	if (!documentId) {
		strapi.log.debug(`[socket.io] Cannot fetch without documentId for ${uid}`);
		return null;
	}
	
	try {
		const populate = normalizePopulate(populateConfig);
		const result = await strapi.documents(uid).findOne({
			documentId,
			populate,
		});
		return result;
	} catch (error) {
		strapi.log.debug(`[socket.io] Error fetching with populate for ${uid}:`, error.message);
		return null;
	}
}

/**
 * Bootstrap lifecycles for content type events
 * @param {object} params - Bootstrap parameters
 * @param {object} params.strapi - Strapi instance
 */
async function bootstrapLifecycles({ strapi }) {
	strapi.config.get('plugin.io.contentTypes', []).forEach((ct) => {
		const uid = ct.uid ? ct.uid : ct;
		const populateConfig = ct.populate;
		const hasPopulate = populateConfig !== undefined;

		const subscriber = {
			models: [uid],
		};

		if (!ct.actions || ct.actions.includes('create')) {
			const eventType = 'create';
			subscriber.afterCreate = async (event) => {
				// Skip if no result data
				if (!event.result) {
					strapi.log.debug(`[socket.io] No result data in afterCreate for ${uid}`);
					return;
				}
				
				const documentId = event.result?.documentId;
				const modelInfo = { singularName: event.model.singularName, uid: event.model.uid };
				
				// Ensure emission runs after transaction commit
				scheduleAfterTransaction(async () => {
					try {
						let data;
						
						// If populate is configured, refetch with relations
						if (hasPopulate && documentId) {
							data = await fetchWithPopulate(strapi, uid, documentId, populateConfig);
							if (!data) {
								// Fallback to original result if refetch fails
								data = JSON.parse(JSON.stringify(event.result));
							}
						} else {
							// Clone data to avoid transaction context issues
							data = JSON.parse(JSON.stringify(event.result));
						}
						
						strapi.$io.emit({
							event: eventType,
							schema: modelInfo,
							data,
						});
					} catch (error) {
						strapi.log.error(`[socket.io] Could not emit create event for ${uid}:`, error.message);
					}
				}, hasPopulate ? 50 : 0); // Small delay when refetching to ensure data is committed
			};
			
			subscriber.afterCreateMany = async (event) => {
				const query = buildEventQuery({ event });
				if (query.filters) {
					// Clone query to avoid transaction context issues
					const clonedQuery = JSON.parse(JSON.stringify(query));
					const modelInfo = { singularName: event.model.singularName, uid: event.model.uid };
					
					// Add populate if configured
					if (hasPopulate) {
						clonedQuery.populate = normalizePopulate(populateConfig);
					}
					
					// Ensure query executes after commit
					scheduleAfterTransaction(async () => {
						try {
							// Use Document Service API (Strapi v5)
							const records = await strapi.documents(uid).findMany(clonedQuery);
							records.forEach((r) => {
								strapi.$io.emit({
									event: eventType,
									schema: { singularName: modelInfo.singularName, uid: modelInfo.uid },
									data: r,
								});
							});
						} catch (error) {
							strapi.log.debug(`[socket.io] Could not fetch records in afterCreateMany for ${uid}:`, error.message);
						}
					}, 50);
				}
			};
		}

		if (!ct.actions || ct.actions.includes('update')) {
			const eventType = 'update';
			subscriber.afterUpdate = async (event) => {
				// Skip if no result data
				if (!event.result) {
					strapi.log.debug(`[socket.io] No result data in afterUpdate for ${uid}`);
					return;
				}
				
				const documentId = event.result?.documentId;
				const modelInfo = { singularName: event.model.singularName, uid: event.model.uid };
				
				// Ensure emission runs after commit
				scheduleAfterTransaction(async () => {
					try {
						let data;
						
						// If populate is configured, refetch with relations
						if (hasPopulate && documentId) {
							data = await fetchWithPopulate(strapi, uid, documentId, populateConfig);
							if (!data) {
								// Fallback to original result if refetch fails
								data = JSON.parse(JSON.stringify(event.result));
							}
						} else {
							// Clone data to avoid transaction context issues
							data = JSON.parse(JSON.stringify(event.result));
						}
						
						strapi.$io.emit({
							event: eventType,
							schema: modelInfo,
							data,
						});
					} catch (error) {
						strapi.log.debug(`[socket.io] Could not emit update event for ${uid}:`, error.message);
					}
				}, hasPopulate ? 50 : 0);
			};
			
			subscriber.beforeUpdateMany = async (event) => {
				// Don't do any queries in before* hooks to avoid transaction conflicts
				// Just store the params for use in afterUpdateMany
				if (!event.state.io) {
					event.state.io = {};
				}
				event.state.io.params = event.params;
			};
			
			subscriber.afterUpdateMany = async (event) => {
				const params = event.state.io?.params;
				if (!params || !params.where) return;
				
				// Clone params to avoid transaction context issues
				const clonedWhere = JSON.parse(JSON.stringify(params.where));
				const modelInfo = { singularName: event.model.singularName, uid: event.model.uid };
				
				// Build query with optional populate
				const query = {
					filters: clonedWhere,
				};
				if (hasPopulate) {
					query.populate = normalizePopulate(populateConfig);
				}
				
				// Ensure query executes after commit
				scheduleAfterTransaction(async () => {
					try {
						// Use Document Service API (Strapi v5)
						const records = await strapi.documents(uid).findMany(query);
						records.forEach((r) => {
							strapi.$io.emit({
								event: eventType,
								schema: { singularName: modelInfo.singularName, uid: modelInfo.uid },
								data: r,
							});
						});
					} catch (error) {
						strapi.log.debug(`[socket.io] Could not fetch records in afterUpdateMany for ${uid}:`, error.message);
					}
				}, 50);
			};
		}

		if (!ct.actions || ct.actions.includes('delete')) {
			const eventType = 'delete';
			subscriber.afterDelete = async (event) => {
				// Skip if no result data
				if (!event.result) {
					strapi.log.debug(`[socket.io] No result data in afterDelete for ${uid}`);
					return;
				}
				// Extract minimal data to avoid transaction context issues
				// Note: populate is not applicable for delete events as the entity no longer exists
				const deleteData = {
					id: event.result?.id || event.result?.documentId,
					documentId: event.result?.documentId || event.result?.id,
				};
				const modelInfo = {
					singularName: event.model.singularName,
					uid: event.model.uid,
				};
				
				// Use raw emit to avoid sanitization queries within transaction
				scheduleAfterTransaction(() => {
					try {
						const eventName = `${modelInfo.singularName}:${eventType}`;
						strapi.$io.raw({
							event: eventName,
							data: deleteData,
						});
					} catch (error) {
						strapi.log.error(`[socket.io] Could not emit delete event for ${uid}:`, error.message);
					}
				}, 100); // Delay to ensure transaction is fully closed
			};
			// Bulk delete events intentionally disabled to avoid transaction issues
		}

		// setup lifecycles
		strapi.db.lifecycles.subscribe(subscriber);
	});
}

/**
 * Builds the query object for findMany operations based on lifecycle event
 * @param {object} params - Parameters
 * @param {object} params.event - The lifecycle event
 * @returns {object} Query object with filters and limit
 */
function buildEventQuery({ event }) {
	const query = {};

	if (event.params.where) {
		query.filters = event.params.where;
	}

	if (event.result?.count) {
		query.limit = event.result.count;
	} else if (event.params.limit) {
		query.limit = event.params.limit;
	}

	if (event.action === 'afterCreateMany') {
		query.filters = { id: event.result.ids };
	} else if (event.action === 'beforeUpdate') {
		query.fields = ['id'];
	}

	return query;
}

module.exports = { bootstrapLifecycles, normalizePopulate };
