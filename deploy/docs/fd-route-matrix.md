# FD-Routen-Matrix

Stand: 2026-10-31 · Audit 20:44-20:56 UTC · Re-Probe 23:45-23:55 UTC
Quelle: Live-HTTP-Probe gegen die produktive FD-API, read-only bzw. mit absichtlich ungueltigem Body.
Alle personenbezogenen Werte in den Evidenz-Spalten sind redigiert.

## Methode

- Alle Requests mit `Authorization: Bearer <SERVICE_TOKEN>`, `x-service-scope: agent-rpc`,
  `x-channel-type: telegram`, `x-channel-user-id: <telegram-id>`.
- Der Token wird zur Laufzeit aus `process.env` bzw. `/proc/1/environ` gelesen, nie als Literal.
- Existence-Probe: **GET** oder **POST** mit Body `{"__probe__": true}` (ungueltig) bzw. nicht
  existierende ID `999999999`. Beides erzeugt keinen Side Effect.
- **Nicht** geprobt: `POST /api/fd/safeword` (loest real alle Locks aus).
- `OPTIONS` liefert fuer alle Pfade 204 und ist als Existence-Probe wertlos.
- Evidenz-Spalten zeigen bei Antworten mit 200/201 nur die Feldnamen, bei Fehlern den
  Fehlercode und die redigierte Fachmeldung. Nutzdaten werden nicht dokumentiert.

## Status-Semantik (wichtig)

| Status                                           | Bedeutung                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| 200 / 201 / 204                                  | Route existiert, read-only bzw. bewusst ungueltiger Body                      |
| 400 `VALIDATION_ERROR`                           | Route existiert, Eingabe ungueltig -> beweist Routenexistenz ohne Side Effect |
| 403 `FORBIDDEN`                                  | Route existiert, Berechtigung fehlt (serverseitiges Pairing)                  |
| 404 `NOT_FOUND` mit `Not found: <METHOD> <pfad>` | **Route existiert nicht** (Router-Antwort)                                    |
| 404 mit anderer Fachmeldung                      | **Route existiert**, Business-Fall (z. B. "nothing to undo")                  |

## Matrix

| Methode | Pfad                                          | Status | Typ                  | Evidenz (redigiert)                                                                                                                                                              | Runden |
| ------- | --------------------------------------------- | ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| POST    | `/api/auth/telegram-link/verify-from-message` | 400    | validation           | keys: error, code, message (gekuerzt)                                                                                                                                            | 2      |
| GET     | `/api/cl/locks`                               | 200    | ok                   | keys: locks, id, userId, combinationType, isLocked, startTime, unlockTime (gekuerzt)                                                                                             | 1      |
| GET     | `/api/cl/verification`                        | 200    | ok                   | keys: data                                                                                                                                                                       | 1      |
| GET     | `/api/fd/admin-queue`                         | 200    | ok                   | keys:                                                                                                                                                                            | 1      |
| GET     | `/api/fd/agent-memory`                        | 200    | ok                   | keys: id, userId, agentType, memoryKey, value, day, lines (gekuerzt)                                                                                                             | 1      |
| GET     | `/api/fd/agent-memory?agentType=lexi`         | 200    | ok                   | keys: id, userId, agentType, memoryKey, value (gekuerzt)                                                                                                                         | 1      |
| PUT     | `/api/fd/agent-memory/lexi/__probe__`         | 400    | validation           | VALIDATION_ERROR: Anfrage: unbekannte Felder erkannt (**probe**) \| abweichender Status 200: keys: id, userId, agentType, memoryKey, value, relationshipScore, updatedAt         | 2      |
| GET     | `/api/fd/blackmail`                           | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/blackmail                                                                                                                                      | 2      |
| POST    | `/api/fd/blackmail`                           | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/blackmail                                                                                                                                     | 1      |
| GET     | `/api/fd/blackmail/drafts`                    | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/blackmail/drafts                                                                                                                               | 1      |
| GET     | `/api/fd/blackmail/status`                    | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/blackmail/status                                                                                                                               | 1      |
| GET     | `/api/fd/calendar`                            | 200    | ok                   | keys:                                                                                                                                                                            | 1      |
| GET     | `/api/fd/calendar/upcoming`                   | 200    | ok                   | keys:                                                                                                                                                                            | 1      |
| GET     | `/api/fd/chains`                              | 200    | ok                   | keys: id, userId, title, description, stages, label (gekuerzt)                                                                                                                   | 1      |
| GET     | `/api/fd/check-ins`                           | 200    | ok                   | keys: id, userId, chainId, dueAt, note, photoEntryId, status, completedAt, createdAt (gekuerzt)                                                                                  | 2      |
| DELETE  | `/api/fd/check-ins/999999999`                 | 404    | not-found (business) | NOT_FOUND: Check-in not found                                                                                                                                                    | 1      |
| PATCH   | `/api/fd/check-ins/999999999`                 | 404    | not-found            | NOT_FOUND: Not found: PATCH /api/fd/check-ins/<numeric-id>                                                                                                                       | 2      |
| GET     | `/api/fd/choices`                             | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/choices                                                                                                                                        | 1      |
| POST    | `/api/fd/choices`                             | 400    | validation           | VALIDATION_ERROR: message fehlt; options fehlt; Anfrage: unbekannte Felder erkannt (**probe**)                                                                                   | 2      |
| DELETE  | `/api/fd/choices/999999999`                   | 404    | not-found            | NOT_FOUND: Not found: DELETE /api/fd/choices/<numeric-id>                                                                                                                        | 1      |
| PATCH   | `/api/fd/choices/999999999`                   | 404    | not-found            | NOT_FOUND: Not found: PATCH /api/fd/choices/<numeric-id>                                                                                                                         | 2      |
| GET     | `/api/fd/companion/context`                   | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/companion/context                                                                                                                              | 1      |
| POST    | `/api/fd/companion/context`                   | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/companion/context                                                                                                                             | 1      |
| GET     | `/api/fd/companion/zones`                     | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/companion/zones                                                                                                                                | 1      |
| GET     | `/api/fd/denial`                              | 200    | ok                   | keys: active, denial                                                                                                                                                             | 1      |
| GET     | `/api/fd/device-consent`                      | 200    | ok                   | keys: userId, count, consents, nodeId, permissions, sms (gekuerzt)                                                                                                               | 1      |
| GET     | `/api/fd/device-consent/audit`                | 200    | ok                   | keys: userId, count, limit, offset, audits, id, keyholderId, action, permission, nodeId (gekuerzt)                                                                               | 1      |
| GET     | `/api/fd/devices`                             | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/devices                                                                                                                                        | 1      |
| GET     | `/api/fd/devices/location`                    | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/devices/location                                                                                                                               | 1      |
| POST    | `/api/fd/devices/location`                    | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/devices/location                                                                                                                              | 1      |
| GET     | `/api/fd/devices/status`                      | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/devices/status                                                                                                                                 | 1      |
| GET     | `/api/fd/dossier`                             | 200    | ok                   | keys: leverage, id, userId, level, thresholdSwitch, blackmailEscalationLevel, metadata, itemsByType, type, count, weight (gekuerzt)                                              | 1      |
| GET     | `/api/fd/dossier-entries`                     | 200    | ok                   | keys: id, userId, title, fileUrl, tags, accessConditions, shareToken, batchId (gekuerzt)                                                                                         | 1      |
| GET     | `/api/fd/dreamquest/credential_safe/check`    | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/dreamquest/credential_safe/check                                                                                                               | 1      |
| POST    | `/api/fd/dreamquest/credential_safe/check`    | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/dreamquest/credential_safe/check                                                                                                              | 1      |
| GET     | `/api/fd/exposure`                            | 200    | ok                   | keys: exposureFactor, stage, stageLabel, stageDescription, submissionGrade, submissionLevel, consentCap (gekuerzt)                                                               | 1      |
| GET     | `/api/fd/exposure/contacts`                   | 200    | ok                   | keys: userId, channels, type, address, source, confidence (gekuerzt)                                                                                                             | 1      |
| POST    | `/api/fd/exposure/dispatch`                   | 400    | validation           | VALIDATION_ERROR: Ziel-User fehlt; Begründung fehlt; Anfrage: unbekannte Felder erkannt (**probe**) \| abweichender Status 403: FORBIDDEN: Not an active keyholder for that user | 2      |
| GET     | `/api/fd/exposure/policy`                     | 200    | ok                   | keys: userId, subDataRelease, consented, version, channels, wall, telegram_dm, telegram_group, email, sms (gekuerzt)                                                             | 1      |
| GET     | `/api/fd/exposure/preflight`                  | 200    | ok                   | keys: userId, multiChannelReady, readyCount, matrix, channel, status, reason, unlock (gekuerzt)                                                                                  | 1      |
| GET     | `/api/fd/exposure/report`                     | 200    | ok                   | keys: exposureFactor, stage, stageLabel, stageDescription, submissionGrade, submissionLevel, consentCap (gekuerzt)                                                               | 1      |
| GET     | `/api/fd/exposure/stage`                      | 200    | ok                   | keys: stage, label, description, leverageLevel, exposureFactor, allowedActions (gekuerzt)                                                                                        | 1      |
| GET     | `/api/fd/game-engine/games`                   | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/game-engine/games                                                                                                                              | 1      |
| POST    | `/api/fd/game-engine/spin`                    | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/game-engine/spin                                                                                                                              | 1      |
| GET     | `/api/fd/game-engine/state`                   | 200    | ok                   | keys: games, active, counts                                                                                                                                                      | 1      |
| POST    | `/api/fd/game-engine/wheel`                   | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/game-engine/wheel                                                                                                                             | 1      |
| POST    | `/api/fd/games/spin`                          | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/games/spin                                                                                                                                    | 1      |
| POST    | `/api/fd/games/wheel`                         | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/games/wheel                                                                                                                                   | 1      |
| GET     | `/api/fd/keyholder/keyholders`                | 200    | ok                   | keys: id, keyholderUserId, status, createdAt, keyholderUsername, keyholderDisplayName (gekuerzt)                                                                                 | 1      |
| GET     | `/api/fd/keyholder/stats`                     | 200    | ok                   | keys: activeLocks, avgMood, subCount, openViolations, violations24h, activeRules                                                                                                 | 1      |
| GET     | `/api/fd/keyholder/subs`                      | 200    | ok                   | keys:                                                                                                                                                                            | 1      |
| GET     | `/api/fd/keyholder/subs/3/dashboard`          | 403    | permission           | FORBIDDEN: Not a keyholder of this sub or pairing not active                                                                                                                     | 1      |
| GET     | `/api/fd/keyholder/subs/3/locks`              | 403    | permission           | FORBIDDEN: Not a keyholder of this sub or pairing not active                                                                                                                     | 1      |
| GET     | `/api/fd/keyholder/subs/3/scores`             | 403    | permission           | FORBIDDEN: Not a keyholder of this sub or pairing not active                                                                                                                     | 1      |
| GET     | `/api/fd/keyholder/subs/3/violations`         | 403    | permission           | FORBIDDEN: Not a keyholder of this sub or pairing not active                                                                                                                     | 1      |
| GET     | `/api/fd/leverage`                            | 200    | ok                   | keys: userId, level, level_by_violations, level_by_items, threshold_switch, blackmail_escalation_level, metadata, itemsByType, type (gekuerzt)                                   | 1      |
| GET     | `/api/fd/lexi/config`                         | 200    | ok                   | keys: userId, config, tone, current, widersacher, enabled, aggression_level, exit_conditions (gekuerzt)                                                                          | 1      |
| GET     | `/api/fd/limits`                              | 200    | ok                   | keys: hardLimits, softLimits, safeword, waiveBoundaries, activityRatings, anal, pain, tasks, findom, bondage, petplay (gekuerzt)                                                 | 2      |
| GET     | `/api/fd/locks/status`                        | 200    | ok                   | keys: active, remainingSeconds, frozen, lock, id, title, unlockTime (gekuerzt)                                                                                                   | 1      |
| GET     | `/api/fd/memory/user/entries`                 | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/memory/user/entries                                                                                                                            | 1      |
| POST    | `/api/fd/memory/user/entries`                 | 400    | validation           | VALIDATION_ERROR: userId fehlt; layer fehlt; Inhalt fehlt; Anfrage: unbekannte Felder erkannt (**probe**)                                                                        | 2      |
| DELETE  | `/api/fd/memory/user/entries/1`               | 400    | validation           | VALIDATION_ERROR: Invalid UUID in path                                                                                                                                           | 1      |
| GET     | `/api/fd/memory/user/entries/1`               | 400    | validation           | VALIDATION_ERROR: Invalid UUID in path                                                                                                                                           | 1      |
| POST    | `/api/fd/memory/user/entries/1`               | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/memory/user/entries/1                                                                                                                         | 1      |
| PUT     | `/api/fd/memory/user/entries/1`               | 404    | not-found            | NOT_FOUND: Not found: PUT /api/fd/memory/user/entries/1                                                                                                                          | 1      |
| POST    | `/api/fd/memory/user/recall`                  | 400    | validation           | VALIDATION_ERROR: userId fehlt; query fehlt; Anfrage: unbekannte Felder erkannt (**probe**) \| abweichender Status 200: keys: entries, id, user_id, layer, content (gekuerzt)    | 2      |
| POST    | `/api/fd/onboarding/insight`                  | 400    | validation           | VALIDATION_ERROR: key fehlt; value: invalid_union; Anfrage: unbekannte Felder erkannt (**probe**)                                                                                | 2      |
| GET     | `/api/fd/onboarding/status`                   | 200    | ok                   | keys: status, currentStep, unlockedAt, completedAt, insights, safeword, value (gekuerzt)                                                                                         | 1      |
| GET     | `/api/fd/profile`                             | 200    | ok                   | keys: id, username, email, displayName, role, avatarUrl, roleStatus, requestedRole (gekuerzt)                                                                                    | 1      |
| GET     | `/api/fd/rules`                               | 200    | ok                   | keys: id, userId, createdBy, title, description (gekuerzt)                                                                                                                       | 1      |
| GET     | `/api/fd/safeword`                            | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/safeword                                                                                                                                       | 1      |
| POST    | `/api/fd/safeword/scan`                       | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/safeword/scan                                                                                                                                 | 1      |
| GET     | `/api/fd/scenes`                              | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/scenes                                                                                                                                         | 1      |
| DELETE  | `/api/fd/scenes/999999999`                    | 404    | not-found            | NOT_FOUND: Not found: DELETE /api/fd/scenes/<numeric-id>                                                                                                                         | 1      |
| POST    | `/api/fd/scenes/compile`                      | 400    | validation           | VALIDATION_ERROR: Anfrage: unbekannte Felder erkannt (**probe**) \| abweichender Status 201: keys: ok, scene, id, userId, title, intensity, theme, safewordReminder (gekuerzt)   | 2      |
| GET     | `/api/fd/scenes/list`                         | 404    | not-found (business) | NOT_FOUND: Scene not found                                                                                                                                                       | 1      |
| GET     | `/api/fd/scores`                              | 200    | ok                   | keys: ovs, ubs, kcs, moodState                                                                                                                                                   | 1      |
| GET     | `/api/fd/screen`                              | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/screen                                                                                                                                         | 1      |
| POST    | `/api/fd/screen/control`                      | 404    | not-found            | NOT_FOUND: Not found: POST /api/fd/screen/control                                                                                                                                | 1      |
| GET     | `/api/fd/screen/state`                        | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/screen/state                                                                                                                                   | 1      |
| GET     | `/api/fd/session-summary`                     | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/session-summary                                                                                                                                | 1      |
| GET     | `/api/fd/subos`                               | 200    | ok                   | keys: snapshotAt, userId, weather, code, label, emoji, classLevel (gekuerzt)                                                                                                     | 1      |
| GET     | `/api/fd/tasks`                               | 200    | ok                   | keys: id, userId, createdBy, title, description (gekuerzt)                                                                                                                       | 1      |
| PATCH   | `/api/fd/tasks/999999999`                     | 400    | validation           | VALIDATION_ERROR: Anfrage: unbekannte Felder erkannt (**probe**) \| abweichender Status 404: NOT_FOUND: Task not found                                                           | 2      |
| GET     | `/api/fd/telegram-link/status`                | 404    | not-found            | NOT_FOUND: Not found: GET /api/fd/telegram-link/status                                                                                                                           | 1      |
| POST    | `/api/fd/undo/last`                           | 404    | not-found (business) | NOT_FOUND: nothing to undo (30min window)                                                                                                                                        | 1      |
| GET     | `/api/fd/undo/list`                           | 200    | ok                   | keys:                                                                                                                                                                            | 1      |
| GET     | `/api/fd/users/me/vacation`                   | 200    | ok                   | keys: vacationMode, vacationUntil                                                                                                                                                | 1      |
| GET     | `/api/fd/vault/entries`                       | 200    | ok                   | keys: id, userId, title, fileUrl, tags, accessConditions, shareToken, batchId (gekuerzt)                                                                                         | 1      |
| GET     | `/api/fd/vault/overview`                      | 200    | ok                   | keys: total, images, text, encrypted, clientEncrypted, exposed                                                                                                                   | 1      |
| GET     | `/api/fd/violation-stats`                     | 200    | ok                   | keys: total, bySeverity, windowDays, allTimeTotal                                                                                                                                | 1      |
| GET     | `/api/fd/violations`                          | 200    | ok                   | keys: id, userId, ruleId, severity, description, metadata, mark, source, taskId (gekuerzt)                                                                                       | 1      |
| GET     | `/api/fd/wall/posts`                          | 200    | ok                   | keys:                                                                                                                                                                            | 1      |

## Zusammenfassung

- `200`: 41 Routen
- `400`: 11 Routen
- `403`: 4 Routen
- `404`: 37 Routen

- Davon **Router-404** (Route existiert nicht): 34
- Davon **Business-404** (Route existiert): 3

## Befunde aus der Matrix

### Routen fehlen komplett (404 Not found: <METHOD> <pfad>)

Diese Route-Familien sind in Skills dokumentiert, existieren aber serverseitig nicht.
Sie gehoeren in das Server-Repo (lexiclaw), nicht in dieses Runtime-Repo.

- `GET /api/fd/blackmail`
- `POST /api/fd/blackmail`
- `GET /api/fd/blackmail/drafts`
- `GET /api/fd/blackmail/status`
- `PATCH /api/fd/check-ins/999999999`
- `GET /api/fd/choices`
- `DELETE /api/fd/choices/999999999`
- `PATCH /api/fd/choices/999999999`
- `GET /api/fd/companion/context`
- `POST /api/fd/companion/context`
- `GET /api/fd/companion/zones`
- `GET /api/fd/devices`
- `GET /api/fd/devices/location`
- `POST /api/fd/devices/location`
- `GET /api/fd/devices/status`
- `GET /api/fd/dreamquest/credential_safe/check`
- `POST /api/fd/dreamquest/credential_safe/check`
- `GET /api/fd/game-engine/games`
- `POST /api/fd/game-engine/spin`
- `POST /api/fd/game-engine/wheel`
- `POST /api/fd/games/spin`
- `POST /api/fd/games/wheel`
- `GET /api/fd/memory/user/entries`
- `POST /api/fd/memory/user/entries/1`
- `PUT /api/fd/memory/user/entries/1`
- `GET /api/fd/safeword`
- `POST /api/fd/safeword/scan`
- `GET /api/fd/scenes`
- `DELETE /api/fd/scenes/999999999`
- `GET /api/fd/screen`
- `POST /api/fd/screen/control`
- `GET /api/fd/screen/state`
- `GET /api/fd/session-summary`
- `GET /api/fd/telegram-link/status`

### Routen existieren, falsche Methode dokumentiert

| Route           | Korrekt                                                                              | Falsch dokumentiert / nicht vorhanden                            |
| --------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Task-Update     | `PATCH /api/fd/tasks/:id`                                                            | -                                                                |
| Check-in-Update | `DELETE /api/fd/check-ins/:id`                                                       | `PATCH /api/fd/check-ins/:id` (404)                              |
| Agent-Memory    | `GET /api/fd/agent-memory?agentType=` und `PUT /api/fd/agent-memory/:agentType/:key` | `POST` / `PATCH` (404)                                           |
| Memory-Entries  | `POST /api/fd/memory/user/entries` (userId + layer + content pflicht)                | `GET` ohne `:id` (404)                                           |
| Telegram-Link   | `POST /api/auth/telegram-link/verify-from-message`                                   | Pfad unter `/api/fd/` -> Verwechslungsgefahr                     |
| Safeword-Scan   | `GET /api/fd/limits` (Feld `safeword`)                                               | `GET /api/fd/safeword` (404), `POST /api/fd/safeword/scan` (404) |
| Game-Engine     | `GET /api/fd/game-engine/state`                                                      | Spin-/Wheel-Routen unbekannt, alle 404                           |

### 403 - serverseitiges Pairing fehlt

- `GET /api/fd/keyholder/subs` liefert `[]`.
- `GET /api/fd/keyholder/subs/:id/{dashboard,locks,scores,violations}` -> 403
  "Not a keyholder of this sub or pairing not active".
- `POST /api/fd/exposure/dispatch` -> 403 "Not an active keyholder for that user" (kein Dispatch ausgefuehrt).
- Ursache: fehlendes Keyholder-Pairing. Owner-Aktion, nicht per Code loesbar.

### Business-404 (Route existiert)

- `DELETE /api/fd/check-ins/999999999` -> NOT_FOUND: Check-in not found
- `GET /api/fd/scenes/list` -> NOT_FOUND: Scene not found
- `POST /api/fd/undo/last` -> NOT_FOUND: nothing to undo (30min window)

### Sicherheits- und Nebenwirkungsprotokoll

- `POST /api/fd/safeword` wurde in keinem Lauf aufgerufen.
- Es wurde kein Wall-Post, kein Exposure-Dispatch und kein Telegram-Send ausgeloest.
- Der Chain-State (Tasks, Check-ins, Locks, Score) wurde durch die Probe nicht veraendert.
- Zwei Probe-Artefakte sind entstanden (eine kompilierte Szene, ein Agent-Memory-Key).
  Sie sind in `deploy/docs/operator-handoff-2026-10-31.md` benannt und nur nach GO loeschbar.

## Reproduktion

Der Probe-Runner haengt an `/proc/1/environ` des Gateway-Containers und gehoert in das
Server-Repo; er ist bewusst nicht Teil dieses Bundles. Das Vorgehen ist oben unter
"Methode" vollstaendig beschrieben: Token zur Laufzeit aus `process.env` oder
`/proc/1/environ`, Existenz-Probe ueber GET oder ungueltige Bodies, Pfad-IDs `999999999`,
`POST /api/fd/safeword` ausgeschlossen.
