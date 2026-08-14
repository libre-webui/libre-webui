/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Coordinator } from '../coordination/index.js';
import type { DurableJobRuntimeService } from '../jobs/durableJobRuntime.js';
import { DurableEventGateway } from './durableEventGateway.js';

let gateway: DurableEventGateway | undefined;

export const initializeDurableEventGateway = (
  service: DurableJobRuntimeService,
  coordinator: Coordinator
): DurableEventGateway => {
  if (gateway) throw new Error('Durable event gateway is already initialized.');
  gateway = new DurableEventGateway(service, coordinator);
  return gateway;
};

export const getDurableEventGateway = (): DurableEventGateway => {
  if (!gateway) throw new Error('Durable event gateway is not initialized.');
  return gateway;
};

export const getDurableEventGatewayIfInitialized = ():
  DurableEventGateway | undefined => gateway;

export const closeDurableEventGateway = async (): Promise<void> => {
  const current = gateway;
  gateway = undefined;
  await current?.close();
};
