(() => {
      "use strict";

      const STORAGE_KEY = "afterglow-party-tickets-v1";
      const HISTORY_KEY = "afterglow-party-scan-history-v1";
      const MAX_PURPOSE_BYTES = 256;
      const MAX_EVENT_CODE_BYTES = 512;
      const tabs = [document.getElementById("create-tab"), document.getElementById("scan-tab")];
      const panels = [document.getElementById("create-panel"), document.getElementById("scan-panel")];
      const video = document.getElementById("camera-video");
      const cameraFrame = document.getElementById("camera-frame");
      const cameraPlaceholder = document.getElementById("camera-placeholder");
      const canvas = document.getElementById("ticket-qr");
      const scanCanvas = document.createElement("canvas");
      const scanContext = scanCanvas.getContext("2d", { willReadFrequently: true });
      let cameraStream = null;
      let scanTimer = null;
      let scanResumeTimer = null;
      let toastTimer = null;
      let lastCameraPayload = null;
      let audioContext = null;
      let tickets = loadTickets();
      let scanHistory = loadScanHistory();

      function setStatus(element, message, type) {
        element.textContent = message;
        element.className = "status" + (type ? " " + type : "");
      }

      function decodeEventCode(value) {
        const hex = value.replace(/\s/g, "");
        if (!hex) return null;
        if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) {
          throw new Error("Enter a valid hex code made of pairs of letters and numbers.");
        }
        if (hex.length / 2 > MAX_EVENT_CODE_BYTES) {
          throw new Error("The event code is too long. Ask the organizer for a shorter code.");
        }
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i += 1) {
          bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        let decoded;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
        } catch {
          throw new Error("This hex code does not contain valid UTF-8 text.");
        }
        if (!decoded) throw new Error("The event code is empty.");

        let config;
        try {
          config = JSON.parse(decoded);
        } catch {
          return { purpose: decoded, eventId: null, limit: null };
        }
        if (!config || config.app !== "afterglow-event" || config.version !== 1 ||
            typeof config.eventId !== "string" || !config.eventId ||
            typeof config.purpose !== "string" || !config.purpose.trim() ||
            (config.limit !== null && (!Number.isInteger(config.limit) || config.limit < 1 || config.limit > 1000000))) {
          throw new Error("This event code has an invalid format.");
        }
        if (new TextEncoder().encode(config.purpose).length > MAX_PURPOSE_BYTES) {
          throw new Error("The purpose in this event code is too long.");
        }
        return { purpose: config.purpose, eventId: config.eventId, limit: config.limit };
      }

      function loadTickets() {
        try {
          const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((ticket) =>
            ticket && typeof ticket.id === "string" &&
            typeof ticket.name === "string" && typeof ticket.event === "string" &&
            typeof ticket.createdAt === "string" && typeof ticket.checkedIn === "boolean" &&
            (!("purpose" in ticket) || (typeof ticket.purpose === "string" &&
              new TextEncoder().encode(ticket.purpose).length <= MAX_PURPOSE_BYTES)) &&
            (!("eventId" in ticket) || (typeof ticket.eventId === "string" && ticket.eventId.length > 0)) &&
            (!("ticketLimit" in ticket) || ticket.ticketLimit === null ||
              (Number.isInteger(ticket.ticketLimit) && ticket.ticketLimit >= 1 && ticket.ticketLimit <= 1000000))
          );
        } catch (error) {
          console.error("Could not read the saved guest list.", error);
          return [];
        }
      }

      function loadScanHistory() {
        try {
          const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
          if (!Array.isArray(parsed)) return [];
          return parsed.filter((entry) =>
            entry && typeof entry.scannedAt === "string" &&
            typeof entry.state === "string" && typeof entry.title === "string" &&
            typeof entry.details === "string" && typeof entry.code === "string" &&
            typeof entry.source === "string"
          );
        } catch (error) {
          console.error("Could not read the scan history.", error);
          return [];
        }
      }

      function saveTickets() {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(tickets));
          updateStats();
          return true;
        } catch (error) {
          console.error("Could not save the guest list.", error);
          setStatus(document.getElementById("roster-status"), "Could not save tickets in this browser. Check available storage.", "error");
          return false;
        }
      }

      function updateStats() {
        document.getElementById("total-count").textContent = String(tickets.length);
        document.getElementById("checked-count").textContent = String(tickets.filter((ticket) => ticket.checkedIn).length);
      }

      function renderScanHistory() {
        const list = document.getElementById("history-list");
        const empty = document.getElementById("history-empty");
        list.replaceChildren();
        document.getElementById("history-count").textContent =
          scanHistory.length + " scan" + (scanHistory.length === 1 ? "" : "s");
        empty.hidden = scanHistory.length > 0;
        scanHistory.slice().reverse().forEach((entry) => {
          const item = document.createElement("li");
          item.className = "history-entry";
          item.dataset.state = entry.state;

          const header = document.createElement("div");
          header.className = "history-entry-header";
          const title = document.createElement("strong");
          title.textContent = entry.title;
          const time = document.createElement("time");
          time.dateTime = entry.scannedAt;
          time.textContent = new Date(entry.scannedAt).toLocaleString();
          header.append(title, time);

          const details = document.createElement("p");
          details.textContent = entry.details + " · " + entry.source;
          const codeDetails = document.createElement("details");
          const summary = document.createElement("summary");
          summary.textContent = "QR data";
          const code = document.createElement("code");
          code.textContent = entry.code;
          codeDetails.append(summary, code);
          item.append(header, details, codeDetails);
          list.append(item);
        });
      }

      function recordScan(state, title, details, code, source) {
        const entry = {
          scannedAt: new Date().toISOString(),
          state,
          title,
          details,
          code,
          source
        };
        scanHistory.push(entry);
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(scanHistory));
          renderScanHistory();
          return true;
        } catch (error) {
          scanHistory.pop();
          console.error("Could not save the scan history.", error);
          setStatus(document.getElementById("roster-status"), "Could not save this scan to history. Check available browser storage.", "error");
          renderScanHistory();
          return false;
        }
      }

      function selectTab(index) {
        tabs.forEach((tab, i) => {
          tab.setAttribute("aria-selected", String(i === index));
          tab.tabIndex = i === index ? 0 : -1;
          panels[i].hidden = i !== index;
        });
        if (index === 0) stopCamera();
        tabs[index].focus();
      }

      tabs.forEach((tab, index) => tab.addEventListener("click", () => selectTab(index)));
      tabs.forEach((tab, index) => tab.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          selectTab(index === 0 ? 1 : 0);
        }
      }));

      document.getElementById("generate-purpose-code").addEventListener("click", () => {
        const purpose = document.getElementById("purpose-description").value.trim();
        const status = document.getElementById("purpose-code-status");
        const limitInput = document.getElementById("event-ticket-limit").value.trim();
        if (!purpose) {
          setStatus(status, "Enter a reason before generating a share code.", "error");
          return;
        }
        const bytes = new TextEncoder().encode(purpose);
        if (bytes.length > MAX_PURPOSE_BYTES) {
          setStatus(status, "Keep the reason to 256 UTF-8 bytes or fewer.", "error");
          return;
        }
        const limit = limitInput ? Number(limitInput) : null;
        if (limitInput && (!Number.isInteger(limit) || limit < 1 || limit > 1000000)) {
          setStatus(status, "Enter a whole-number ticket limit between 1 and 1,000,000.", "error");
          return;
        }
        const config = {
          app: "afterglow-event",
          version: 1,
          eventId: window.crypto && typeof window.crypto.randomUUID === "function"
            ? window.crypto.randomUUID()
            : "event-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12),
          purpose,
          limit
        };
        const configBytes = new TextEncoder().encode(JSON.stringify(config));
        if (configBytes.length > MAX_EVENT_CODE_BYTES) {
          setStatus(status, "The event code is too long. Shorten the reason and try again.", "error");
          return;
        }
        const hex = Array.from(configBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        document.getElementById("purpose-code-output").value = hex;
        document.getElementById("copy-purpose-code").disabled = false;
        setStatus(status, "Event code generated. Share it with guests and use the same code to scan tickets.", "success");
      });

      function invalidateEventCode() {
        document.getElementById("purpose-code-output").value = "";
        document.getElementById("copy-purpose-code").disabled = true;
        setStatus(document.getElementById("purpose-code-status"), "Generate a new code after changing the event reason or ticket limit.");
      }

      document.getElementById("purpose-description").addEventListener("input", invalidateEventCode);
      document.getElementById("event-ticket-limit").addEventListener("input", invalidateEventCode);

      document.getElementById("copy-purpose-code").addEventListener("click", async () => {
        const output = document.getElementById("purpose-code-output");
        const status = document.getElementById("purpose-code-status");
        try {
          await navigator.clipboard.writeText(output.value);
          setStatus(status, "Share code copied.", "success");
        } catch (error) {
          console.error("Could not copy the purpose code.", error);
          output.select();
          setStatus(status, "Could not access the clipboard. The code is selected so you can copy it manually.", "error");
        }
      });

      document.getElementById("ticket-purpose-code").addEventListener("input", (event) => {
        const preview = document.getElementById("purpose-preview");
        const code = event.target.value.trim();
        if (!code) {
          preview.textContent = "No purpose code added.";
          preview.className = "field-hint";
          return;
        }
        try {
          const config = decodeEventCode(code);
          preview.textContent = config
            ? "Purpose: " + config.purpose + (config.limit === null ? " · No ticket limit" : " · Limit: " + config.limit)
            : "No event code added.";
          preview.className = "field-hint";
        } catch (error) {
          preview.textContent = error.message;
          preview.className = "field-hint error";
        }
      });

      document.getElementById("scan-purpose-code").addEventListener("input", (event) => {
        const preview = document.getElementById("scan-purpose-preview");
        const code = event.target.value.trim();
        if (!code) {
          preview.textContent = "Enter the code shared for this event before scanning tickets.";
          preview.className = "field-hint";
          return;
        }
        try {
          const config = decodeEventCode(code);
          preview.textContent = config
            ? "Event: " + config.purpose + (config.limit === null ? " · No ticket limit" : " · Limit: " + config.limit)
            : "Enter the code shared for this event before scanning tickets.";
          preview.className = "field-hint";
        } catch (error) {
          preview.textContent = error.message;
          preview.className = "field-hint error";
        }
      });

      document.getElementById("ticket-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = document.getElementById("guest-name").value.trim();
        const party = document.getElementById("event-name").value.trim();
        const purposeCode = document.getElementById("ticket-purpose-code").value;
        const status = document.getElementById("create-status");
        if (!name || !party) {
          setStatus(status, "Enter both a guest name and party name.", "error");
          return;
        }
        let eventConfig = null;
        try {
          eventConfig = decodeEventCode(purposeCode);
        } catch (error) {
          setStatus(status, error.message, "error");
          return;
        }
        if (eventConfig && eventConfig.limit !== null) {
          tickets = loadTickets();
          updateStats();
          const createdForEvent = tickets.filter((saved) => saved.eventId === eventConfig.eventId).length;
          if (createdForEvent >= eventConfig.limit) {
            setStatus(status, "This event has reached its limit of " + eventConfig.limit + " QR tickets on this device.", "error");
            return;
          }
        }
        if (typeof window.qrcode !== "function") {
          setStatus(status, "QR creation could not load. Check your internet connection and try again.", "error");
          return;
        }

        const ticket = {
          version: 1,
          id: window.crypto && typeof window.crypto.randomUUID === "function"
            ? window.crypto.randomUUID()
            : "ticket-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12),
          name,
          event: party,
          createdAt: new Date().toISOString(),
          checkedIn: false,
          ...(eventConfig ? { purpose: eventConfig.purpose } : {}),
          ...(eventConfig && eventConfig.eventId ? { eventId: eventConfig.eventId } : {}),
          ...(eventConfig && eventConfig.eventId ? { ticketLimit: eventConfig.limit } : {})
        };
        const payload = JSON.stringify({
          app: "afterglow-ticket",
          version: 1,
          id: ticket.id,
          name: ticket.name,
          event: ticket.event,
          ...(eventConfig ? { purpose: eventConfig.purpose } : {}),
          ...(eventConfig && eventConfig.eventId ? { eventId: eventConfig.eventId } : {}),
          ...(eventConfig && eventConfig.eventId ? { ticketLimit: eventConfig.limit } : {})
        }).replace(/[^\x00-\x7f]/g, (character) =>
          "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")
        );

        try {
          const qr = window.qrcode(0, "M");
          qr.addData(payload);
          qr.make();
          const image = new Image();
          const imageReady = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
          image.src = qr.createDataURL(8, 4);
          await imageReady;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas is unavailable.");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0);
        } catch (error) {
          console.error("Could not generate the QR code.", error);
          setStatus(status, "The QR code could not be generated. Please try again.", "error");
          return;
        }

        tickets.push(ticket);
        if (!saveTickets()) {
          tickets = tickets.filter((saved) => saved.id !== ticket.id);
          return;
        }
        document.getElementById("ticket-event").textContent = ticket.event;
        document.getElementById("ticket-name").textContent = ticket.name;
        document.getElementById("ticket-id").textContent = "Ticket " + ticket.id.slice(0, 8).toUpperCase();
        document.getElementById("ticket-empty").hidden = true;
        const ticketResult = document.getElementById("ticket-result");
        ticketResult.style.display = "block";
        setStatus(status, "Ticket created and added to this device’s door list.", "success");
      });

      document.getElementById("download-qr").addEventListener("click", () => {
        const link = document.createElement("a");
        link.download = "afterglow-ticket.png";
        link.href = canvas.toDataURL("image/png");
        link.click();
      });

      document.getElementById("print-ticket").addEventListener("click", () => {
        const image = canvas.toDataURL("image/png");
        const name = document.getElementById("ticket-name").textContent;
        const party = document.getElementById("ticket-event").textContent;
        const printWindow = window.open("", "_blank", "noopener");
        if (!printWindow) {
          setStatus(document.getElementById("create-status"), "Allow pop-ups to print the ticket, or save the QR image instead.", "error");
          return;
        }
        printWindow.document.write("<!doctype html><title>Party ticket</title><style>body{font:16px system-ui;text-align:center;padding:40px;color:#171923}img{width:260px}h1{font-size:24px}p{color:#555}</style><h1>" +
          escapeHtml(party) + "</h1><img src=\"" + image + "\" alt=\"Ticket QR code\"><p>" + escapeHtml(name) + "</p>");
        printWindow.document.close();
        printWindow.focus();
        printWindow.print();
      });

      function escapeHtml(value) {
        return value.replace(/[&<>"']/g, (character) => ({
          "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
        })[character]);
      }

      document.getElementById("export-list").addEventListener("click", () => {
        const file = new Blob([JSON.stringify({ app: "afterglow-guest-list", version: 1, tickets }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(file);
        const link = document.createElement("a");
        link.href = url;
        link.download = "afterglow-door-list.json";
        link.click();
        URL.revokeObjectURL(url);
        setStatus(document.getElementById("roster-status"), "Door list exported. Share the file with your door staff.", "success");
      });

      document.getElementById("import-list").addEventListener("click", () => document.getElementById("import-file").click());
      document.getElementById("import-file").addEventListener("change", async (event) => {
        const file = event.target.files && event.target.files[0];
        const status = document.getElementById("roster-status");
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (!data || data.app !== "afterglow-guest-list" || data.version !== 1 || !Array.isArray(data.tickets)) {
            throw new Error("This file is not an Afterglow guest list.");
          }
          const valid = data.tickets.filter((ticket) =>
            ticket && ticket.version === 1 && typeof ticket.id === "string" &&
            typeof ticket.name === "string" && typeof ticket.event === "string" &&
            typeof ticket.createdAt === "string" && typeof ticket.checkedIn === "boolean" &&
            (!("purpose" in ticket) || (typeof ticket.purpose === "string" &&
              new TextEncoder().encode(ticket.purpose).length <= MAX_PURPOSE_BYTES)) &&
            (!("eventId" in ticket) || (typeof ticket.eventId === "string" && ticket.eventId.length > 0)) &&
            (!("ticketLimit" in ticket) || ticket.ticketLimit === null ||
              (Number.isInteger(ticket.ticketLimit) && ticket.ticketLimit >= 1 && ticket.ticketLimit <= 1000000))
          );
          if (valid.length !== data.tickets.length) throw new Error("The guest list contains invalid ticket data.");
          const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
          valid.forEach((ticket) => {
            const existing = byId.get(ticket.id);
            byId.set(ticket.id, existing ? { ...ticket, checkedIn: existing.checkedIn || ticket.checkedIn } : ticket);
          });
          tickets = Array.from(byId.values());
          if (!saveTickets()) return;
          setStatus(status, valid.length + " ticket" + (valid.length === 1 ? "" : "s") + " imported. Existing check-ins were kept.", "success");
        } catch (error) {
          console.error("Could not import the guest list.", error);
          setStatus(status, error instanceof SyntaxError ? "That file is not valid JSON." : error.message, "error");
        } finally {
          event.target.value = "";
        }
      });

      function getAudioContext() {
        if (!audioContext) {
          const AudioContext = window.AudioContext || window.webkitAudioContext;
          if (AudioContext) audioContext = new AudioContext();
        }
        if (audioContext && audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
        }
        return audioContext;
      }

      function playTone(frequency, start, duration, volume, type = "sine") {
        const context = getAudioContext();
        if (!context) return;

        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, context.currentTime + start);
        gain.gain.setValueAtTime(0.0001, context.currentTime + start);
        gain.gain.exponentialRampToValueAtTime(volume, context.currentTime + start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + start + duration);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(context.currentTime + start);
        oscillator.stop(context.currentTime + start + duration + 0.02);
      }

      function playScanSound(state) {
        if (state === "valid") {
          [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
            playTone(frequency, index * 0.09, 0.38, 0.09, "triangle");
          });
          playTone(392, 0.32, 0.55, 0.035, "sine");
          playTone(587.33, 0.32, 0.55, 0.025, "sine");
        } else {
          playTone(196, 0, 0.22, 0.11, "square");
          playTone(164.81, 0.16, 0.28, 0.11, "square");
          playTone(130.81, 0.36, 0.42, 0.09, "sawtooth");
        }
      }

      function unlockScanAudio() {
        getAudioContext();
      }

      function showScanResult(state, title, details, label) {
        const result = document.getElementById("scan-result");
        result.dataset.state = state;
        result.className = "scan-result result-" + state;
        result.hidden = false;
        document.getElementById("result-label").textContent = label;
        document.getElementById("result-title").textContent =
          state === "valid" ? "QR TICKET VALIDE" : "QR TICKET NON VALIDE";
        document.getElementById("result-details").textContent = details;
        playScanSound(state);
        if (toastTimer !== null) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
          result.hidden = true;
          toastTimer = null;
        }, 1000);
      }

      function finishScan(state, title, details, label, raw, source) {
        pauseCameraScanning();
        const saved = recordScan(state, title, details, raw, source);
        showScanResult(state, title, saved ? details : details + " Scan history could not be saved.", label);
        resumeCameraScanning();
      }

      function resumeCameraScanning() {
        if (cameraStream) {
          if (scanResumeTimer !== null) window.clearTimeout(scanResumeTimer);
          scanResumeTimer = window.setTimeout(() => {
            scanResumeTimer = null;
            if (cameraStream && scanTimer === null) scanTimer = window.setInterval(scanFrame, 180);
          }, 1000);
        }
      }

      function verifyPayload(raw, source) {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          finishScan("invalid", "Not an Afterglow ticket", "This QR code does not contain a valid party ticket.", "Not recognized", raw, source);
          return;
        }
        if (!payload || payload.app !== "afterglow-ticket" || payload.version !== 1 ||
            typeof payload.id !== "string" || typeof payload.name !== "string" || typeof payload.event !== "string" ||
            ("purpose" in payload && (typeof payload.purpose !== "string" ||
              new TextEncoder().encode(payload.purpose).length > MAX_PURPOSE_BYTES)) ||
            ("eventId" in payload && (typeof payload.eventId !== "string" || !payload.eventId)) ||
            ("ticketLimit" in payload && payload.ticketLimit !== null &&
              (!Number.isInteger(payload.ticketLimit) || payload.ticketLimit < 1 || payload.ticketLimit > 1000000))) {
          finishScan("invalid", "Not an Afterglow ticket", "This QR code is not a valid ticket for this app.", "Not recognized", raw, source);
          return;
        }

        let expectedEvent;
        try {
          expectedEvent = decodeEventCode(document.getElementById("scan-purpose-code").value);
          if (!expectedEvent) throw new Error("Paste this event’s hex code before scanning tickets.");
        } catch (error) {
          finishScan("invalid", "Event code required", error.message, "Event not selected", raw, source);
          return;
        }

        const purpose = payload.purpose || "";
        const eventCodeMatches = purpose === expectedEvent.purpose &&
          (payload.eventId || null) === expectedEvent.eventId &&
          (payload.ticketLimit === undefined ? null : payload.ticketLimit) === expectedEvent.limit;
        if (!eventCodeMatches) {
          finishScan("invalid", "Wrong event", "This ticket belongs to a different event or has a different ticket limit. Expected: " + expectedEvent.purpose + ".", "Wrong event", raw, source);
          return;
        }

        const ticket = tickets.find((saved) => saved.id === payload.id);
        if (!ticket || ticket.name !== payload.name || ticket.event !== payload.event ||
            (ticket.purpose || "") !== purpose ||
            (ticket.eventId || null) !== (payload.eventId || null) ||
            (ticket.ticketLimit === undefined ? null : ticket.ticketLimit) !==
              (payload.ticketLimit === undefined ? null : payload.ticketLimit)) {
          const reason = purpose ? " · Purpose: " + purpose : "";
          finishScan("invalid", "Ticket not on guest list", payload.name + " · " + payload.event + reason + ". Import the host’s door list to verify this ticket.", "Not found", raw, source);
          return;
        }
        if (ticket.checkedIn) {
          const reason = purpose ? " · Purpose: " + purpose : "";
          finishScan("used", "Already checked in", ticket.name + " · " + ticket.event + reason + ". This ticket has already been scanned.", "Duplicate entry", raw, source);
          return;
        }
        ticket.checkedIn = true;
        if (!saveTickets()) {
          ticket.checkedIn = false;
          finishScan("invalid", "Could not save check-in", "Storage failed, so this ticket has not been marked as checked in.", "Try again", raw, source);
          return;
        }
        const reason = purpose ? " · Purpose: " + purpose : "";
        finishScan("valid", "You’re on the list!", ticket.name + " · " + ticket.event + reason + ". Check-in complete.", "Valid ticket", raw, source);
        if (navigator.vibrate) navigator.vibrate(100);
      }

      async function startCamera() {
        const status = document.getElementById("scan-status");
        try {
          if (!decodeEventCode(document.getElementById("scan-purpose-code").value)) {
            setStatus(status, "Paste this event’s hex code before starting the scanner.", "error");
            return;
          }
        } catch (error) {
          setStatus(status, error.message, "error");
          return;
        }
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
          setStatus(status, "Camera access is unavailable. Open this site over HTTPS or use a supported browser.", "error");
          return;
        }
        if (!window.jsQR) {
          setStatus(status, "The QR scanner could not load. Check your internet connection and try again.", "error");
          return;
        }
        try {
          if (cameraStream) {
            document.getElementById("start-camera").hidden = true;
            setStatus(status, "Camera is on. Hold the next QR code steady inside the frame.", "success");
            scanTimer = window.setInterval(scanFrame, 180);
            return;
          }
          cameraStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" } }
          });
          video.srcObject = cameraStream;
          await video.play();
          cameraFrame.classList.add("active");
          cameraPlaceholder.hidden = true;
          const startButton = document.getElementById("start-camera");
          startButton.hidden = true;
          startButton.textContent = "Scan next ticket";
          document.getElementById("stop-camera").hidden = false;
          setStatus(status, "Camera is on. Hold the QR code steady inside the frame.", "success");
          scanTimer = window.setInterval(scanFrame, 180);
        } catch (error) {
          console.error("Could not start the camera.", error);
          setStatus(status, error.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access in your browser settings."
            : "Could not start the camera. Check camera permissions and try again.", "error");
        }
      }

      function pauseCameraScanning() {
        if (scanTimer !== null) {
          window.clearInterval(scanTimer);
          scanTimer = null;
        }
      }

      function scanFrame() {
        if (video.readyState !== video.HAVE_ENOUGH_DATA || !video.videoWidth || !scanContext) return;
        scanCanvas.width = video.videoWidth;
        scanCanvas.height = video.videoHeight;
        scanContext.drawImage(video, 0, 0, scanCanvas.width, scanCanvas.height);
        const image = scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
        const decoded = window.jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (!decoded || !decoded.data) {
          lastCameraPayload = null;
          return;
        }
        if (decoded.data !== lastCameraPayload) {
          lastCameraPayload = decoded.data;
          verifyPayload(decoded.data, "Camera");
        }
      }

      document.getElementById("import-qr-image").addEventListener("click", () => {
        document.getElementById("qr-image-file").click();
      });
      document.getElementById("qr-image-file").addEventListener("change", async (event) => {
        const file = event.target.files && event.target.files[0];
        const status = document.getElementById("scan-status");
        if (!file) return;
        pauseCameraScanning();
        let imageUrl;
        try {
          if (!file.type.startsWith("image/")) {
            throw new Error("Please choose an image file containing a QR code.");
          }
          if (!window.jsQR) {
            throw new Error("The QR scanner could not load. Check your internet connection and try again.");
          }
          if (!scanContext) {
            throw new Error("Image scanning is not available in this browser.");
          }

          setStatus(status, "Reading the QR code from the image...");
          imageUrl = URL.createObjectURL(file);
          const image = new Image();
          const imageReady = new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
          image.src = imageUrl;
          await imageReady;

          scanCanvas.width = image.naturalWidth;
          scanCanvas.height = image.naturalHeight;
          scanContext.drawImage(image, 0, 0);
          const pixels = scanContext.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
          const decoded = window.jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: "dontInvert" });
          if (!decoded || !decoded.data) {
            showScanResult("invalid", "No QR code found", "Choose a clear image containing a readable QR code.", "Image not recognized");
            resumeCameraScanning();
            setStatus(status, "No readable QR code was found in that image.", "error");
            return;
          }
          verifyPayload(decoded.data, "Image");
        } catch (error) {
          console.error("Could not read the QR image.", error);
          showScanResult("invalid", "Could not read the image", error.message || "Choose another image and try again.", "Image error");
          resumeCameraScanning();
          setStatus(status, error.message || "Could not read the image. Please try again.", "error");
        } finally {
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          event.target.value = "";
        }
      });

      function stopCamera() {
        if (scanTimer !== null) {
          window.clearInterval(scanTimer);
          scanTimer = null;
        }
        if (scanResumeTimer !== null) {
          window.clearTimeout(scanResumeTimer);
          scanResumeTimer = null;
        }
        if (cameraStream) {
          cameraStream.getTracks().forEach((track) => track.stop());
          cameraStream = null;
        }
        video.srcObject = null;
        lastCameraPayload = null;
        cameraFrame.classList.remove("active");
        cameraPlaceholder.hidden = false;
        const startButton = document.getElementById("start-camera");
        startButton.hidden = false;
        startButton.textContent = "Start camera";
        document.getElementById("stop-camera").hidden = true;
      }

      document.getElementById("start-camera").addEventListener("click", unlockScanAudio);
      document.getElementById("start-camera").addEventListener("click", startCamera);
      document.getElementById("import-qr-image").addEventListener("click", unlockScanAudio);
      document.getElementById("stop-camera").addEventListener("click", stopCamera);
      window.addEventListener("pagehide", stopCamera);
      updateStats();
      renderScanHistory();
    })();
