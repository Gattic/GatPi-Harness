"use strict";

// Permissions of the shared "queue" ACL user: queue keys only, no administrative
// commands. The queue scripts read server TIME so leases do not depend on client
// clocks; ioredis needs INFO and CLIENT SETNAME/SETINFO when it connects.
const QUEUE_USER_PERMISSIONS = "~piq:* +@read +@write +@connection +@scripting -@dangerous +info +client|setname +client|setinfo +time";

module.exports = { QUEUE_USER_PERMISSIONS };
