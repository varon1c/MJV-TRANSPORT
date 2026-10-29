let csrfToken = "";
let searchTimer;

const byId = (id) => document.getElementById(id);

function node(tag, text = "", className = "") {
    const element = document.createElement(tag);
    if (text !== null && text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) {
        headers.set("Content-Type", "application/json");
    }
    if (options.method && !["GET", "HEAD"].includes(options.method)) {
        headers.set("X-CSRF-Token", csrfToken);
    }
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        headers,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}

function setStatus(message, isError = false) {
    const status = byId("admin-status");
    status.textContent = message;
    status.classList.toggle("is-error", isError);
}

function showDashboard(username) {
    byId("login-panel").hidden = true;
    byId("dashboard-panel").hidden = false;
    byId("admin-username-label").textContent = username;
}

function showLogin() {
    csrfToken = "";
    byId("dashboard-panel").hidden = true;
    byId("login-panel").hidden = false;
}

function appendTable(container, headings, rows, emptyMessage) {
    container.replaceChildren();
    if (!rows.length) {
        container.append(node("p", emptyMessage, "empty-state"));
        return;
    }
    const table = node("table", "", "admin-table");
    const head = table.createTHead().insertRow();
    headings.forEach((heading) => head.append(node("th", heading)));
    const body = table.createTBody();
    rows.forEach((cells) => {
        const row = body.insertRow();
        cells.forEach((cell) => {
            const tableCell = row.insertCell();
            if (cell instanceof Node) tableCell.append(cell);
            else tableCell.textContent = cell === null || cell === undefined ? "—" : String(cell);
        });
    });
    container.append(table);
}

function dateTime(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function renderCounts(counts) {
    const labels = [
        ["pending_bookings", "Pending bookings"],
        ["confirmed_bookings", "Confirmed bookings"],
        ["active_vehicles", "Active vehicles"],
        ["open_inquiries", "Open inquiries"],
        ["open_applications", "Open applications"],
    ];
    const container = byId("summary-cards");
    container.replaceChildren();
    labels.forEach(([key, label]) => {
        const card = node("div", "", "summary-card");
        card.append(node("span", label), node("strong", counts[key]));
        container.append(card);
    });
}

function renderVehicles(vehicles) {
    appendTable(
        byId("vehicles-table"),
        ["Fleet", "Model", "Capacity", "Rate", "Availability", "Website", "Edit"],
        vehicles.map((vehicle) => {
            const edit = node("button", "Edit", "secondary-button");
            edit.type = "button";
            edit.addEventListener("click", () => editVehicle(vehicle));
            const amount = vehicle.rental_rate === null
                ? "Not quoted"
                : `${vehicle.rental_rate}`;
            return [
                vehicle.name,
                vehicle.model,
                `${vehicle.capacity} passengers`,
                amount,
                vehicle.availability_status,
                vehicle.is_active ? "Active" : "Inactive",
                edit,
            ];
        }),
        "No vehicles found.",
    );
}

function selectWithOptions(options, currentValue) {
    const select = node("select");
    options.forEach((value) => {
        const option = node("option", value.replaceAll("_", " "));
        option.value = value;
        option.selected = value === currentValue;
        select.append(option);
    });
    return select;
}

async function saveRecord(type, id, status, notes, quotedAmount) {
    await api(`/api/admin/${type}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
            status,
            admin_notes: notes,
            ...(type === "bookings" ? { quoted_amount: quotedAmount } : {}),
        }),
    });
    setStatus("Record updated.");
    await loadDashboard();
}

function recordControls(type, id, status, notes, choices, quotedAmount) {
    const controls = node("div");
    const select = selectWithOptions(choices, status);
    const note = node("textarea");
    note.value = notes || "";
    note.maxLength = 3000;
    note.setAttribute("aria-label", "Administrative notes");
    let quote;
    if (type === "bookings") {
        quote = node("input");
        quote.type = "number";
        quote.min = "0";
        quote.step = "0.01";
        quote.value = quotedAmount ?? "";
        quote.placeholder = "No quote";
        quote.setAttribute("aria-label", "Quoted amount (optional)");
    }
    const save = node("button", "Save changes");
    save.type = "button";
    save.addEventListener("click", async () => {
        save.disabled = true;
        try {
            await saveRecord(type, id, select.value, note.value, quote?.value ?? null);
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            save.disabled = false;
        }
    });
    if (quote) controls.append(quote);
    controls.append(select, note, save);
    return controls;
}

function renderBookings(bookings) {
    appendTable(
        byId("bookings-table"),
        ["Reference", "Customer", "Vehicle", "Travel window", "Trip", "Passengers", "Manage"],
        bookings.map((booking) => {
            const contact = [booking.email, booking.phone].filter(Boolean).join(" · ");
            const trip = node("div", [
                `Pickup: ${booking.pickup_location}`,
                booking.destination ? `Destination: ${booking.destination}` : "",
                booking.special_requests ? `Requests: ${booking.special_requests}` : "",
            ].filter(Boolean).join("\n"), "record-summary");
            return [
                `${booking.reference} · ${booking.status}`,
                node("div", `${booking.full_name}\n${contact}`, "record-summary"),
                `${booking.vehicle_name} · ${booking.vehicle_model}`,
                node("div", `From ${dateTime(booking.pickup_at)}\nTo ${dateTime(booking.return_at)}`, "record-summary"),
                trip,
                booking.passengers,
                recordControls(
                    "bookings", booking.id, booking.status, booking.admin_notes,
                    ["pending", "confirmed", "rejected", "cancelled", "completed"],
                    booking.quoted_amount,
                ),
            ];
        }),
        "No booking requests found.",
    );
}

function renderInquiries(inquiries) {
    appendTable(
        byId("inquiries-table"),
        ["Message", "Customer", "Submitted", "Manage"],
        inquiries.map((inquiry) => [
            node("div", `${inquiry.subject}\n${inquiry.message}`, "record-summary"),
            node("div", `${inquiry.full_name}\n${inquiry.email}${inquiry.phone ? `\n${inquiry.phone}` : ""}`, "record-summary"),
            dateTime(inquiry.created_at),
            recordControls(
                "inquiries", inquiry.id, inquiry.status, inquiry.admin_notes,
                ["new", "in_progress", "resolved", "archived"],
            ),
        ]),
        "No customer inquiries found.",
    );
}

function renderApplications(applications) {
    appendTable(
        byId("applications-table"),
        ["Applicant", "Position", "Details", "Documents", "Submitted", "Manage"],
        applications.map((application) => {
            const documents = node("div");
            Object.entries(application.files || {}).forEach(([field, file]) => {
                const link = node("a", field.replaceAll("-", " "));
                link.href = `/api/admin/applications/${application.id}/files/${encodeURIComponent(field)}`;
                link.download = file.name;
                documents.append(link, document.createElement("br"));
            });
            return [
                node("div", `${application.full_name}\n${application.email}${application.phone ? `\n${application.phone}` : ""}`, "record-summary"),
                application.position,
                node("div", `Birthday: ${application.birthday}\nNationality: ${application.nationality}\nBirthplace: ${application.birthplace}${application.message ? `\n${application.message}` : ""}`, "record-summary"),
                documents,
                dateTime(application.created_at),
                recordControls(
                    "applications", application.id, application.status, application.admin_notes,
                    ["new", "reviewing", "shortlisted", "rejected", "hired"],
                ),
            ];
        }),
        "No applications found.",
    );
}

function renderAudit(entries) {
    appendTable(
        byId("audit-table"),
        ["Time", "Administrator", "Action", "Record"],
        entries.map((entry) => [
            dateTime(entry.created_at),
            entry.admin_username,
            entry.action.replaceAll("_", " "),
            `${entry.entity_type} ${entry.entity_id}`,
        ]),
        "No administrative actions recorded yet.",
    );
}

async function loadDashboard() {
    const search = new URLSearchParams({ search: byId("admin-search").value });
    const data = await api(`/api/admin/dashboard?${search}`);
    renderCounts(data.counts);
    renderVehicles(data.vehicles);
    renderBookings(data.bookings);
    renderInquiries(data.inquiries);
    renderApplications(data.applications);
    renderAudit(data.audit);
}

function editVehicle(vehicle) {
    const form = byId("vehicle-form");
    form.hidden = false;
    form.elements.namedItem("id").value = vehicle.id;
    form.elements.namedItem("name").value = vehicle.name;
    form.elements.namedItem("model").value = vehicle.model;
    form.elements.namedItem("category").value = vehicle.category;
    form.elements.namedItem("capacity").value = vehicle.capacity;
    form.elements.namedItem("rental_rate").value = vehicle.rental_rate ?? "";
    form.elements.namedItem("image_path").value = vehicle.image_path;
    form.elements.namedItem("availability_status").value = vehicle.availability_status;
    form.elements.namedItem("is_active").checked = vehicle.is_active;
    form.elements.namedItem("description").value = vehicle.description;
    byId("vehicle-name").focus();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetVehicleForm() {
    const form = byId("vehicle-form");
    form.reset();
    form.elements.namedItem("id").value = "";
    form.elements.namedItem("category").value = "van";
    form.elements.namedItem("image_path").value = "images/van.png";
    form.elements.namedItem("is_active").checked = true;
    form.hidden = true;
}

document.addEventListener("DOMContentLoaded", async () => {
    const loginForm = byId("login-form");
    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!loginForm.reportValidity()) return;
        const submit = loginForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            const result = await api("/api/admin/login", {
                method: "POST",
                body: JSON.stringify({
                    username: loginForm.elements.namedItem("username").value,
                    password: loginForm.elements.namedItem("password").value,
                }),
            });
            csrfToken = result.csrf;
            showDashboard(result.username);
            loginForm.reset();
            setStatus("");
            await loadDashboard();
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            submit.disabled = false;
        }
    });

    byId("logout-button").addEventListener("click", async () => {
        try {
            await api("/api/admin/logout", { method: "POST" });
            showLogin();
            setStatus("You have signed out.");
        } catch (error) {
            setStatus(error.message, true);
        }
    });

    byId("refresh-dashboard").addEventListener("click", async () => {
        try {
            await loadDashboard();
            setStatus("Dashboard refreshed.");
        } catch (error) {
            setStatus(error.message, true);
        }
    });

    byId("admin-search").addEventListener("input", () => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(async () => {
            try {
                await loadDashboard();
                setStatus("");
            } catch (error) {
                setStatus(error.message, true);
            }
        }, 250);
    });

    byId("new-vehicle-button").addEventListener("click", () => {
        resetVehicleForm();
        byId("vehicle-form").hidden = false;
        byId("vehicle-name").focus();
    });
    byId("cancel-vehicle-edit").addEventListener("click", resetVehicleForm);
    byId("vehicle-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!form.reportValidity()) return;
        const button = form.querySelector('button[type="submit"]');
        const values = new FormData(form);
        const vehicle = Object.fromEntries(values.entries());
        vehicle.capacity = Number(vehicle.capacity);
        vehicle.rental_rate = vehicle.rental_rate === "" ? null : Number(vehicle.rental_rate);
        vehicle.is_active = values.has("is_active");
        button.disabled = true;
        try {
            const id = values.get("id");
            await api(id ? `/api/admin/vehicles/${id}` : "/api/admin/vehicles", {
                method: id ? "PUT" : "POST",
                body: JSON.stringify(vehicle),
            });
            resetVehicleForm();
            setStatus("Vehicle saved.");
            await loadDashboard();
        } catch (error) {
            setStatus(error.message, true);
        } finally {
            button.disabled = false;
        }
    });

    try {
        const session = await api("/api/admin/session");
        csrfToken = session.csrf;
        showDashboard(session.username);
        await loadDashboard();
    } catch (error) {
        showLogin();
        if (error.message !== "Admin sign-in is required.") setStatus(error.message, true);
    }
});
