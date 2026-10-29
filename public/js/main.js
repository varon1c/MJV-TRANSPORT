function toggleMenu() {
    const menu = document.getElementById("navPills");
    const button = document.querySelector(".hamburger-menu");
    if (!menu || !button) return;

    const isOpen = menu.classList.toggle("is-open");
    button.setAttribute("aria-expanded", String(isOpen));
}

function formatMonth(date) {
    return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

function renderCalendar(container, initialDate, onSelect) {
    let visibleMonth = new Date(initialDate.getFullYear(), initialDate.getMonth(), 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const wrapper = document.createElement("section");
    wrapper.className = "interactive-calendar";
    wrapper.setAttribute("aria-label", "Choose a travel date");

    const heading = document.createElement("div");
    heading.className = "calendar-heading";
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "calendar-arrow";
    previous.setAttribute("aria-label", "Previous month");
    previous.textContent = "‹";
    const monthLabel = document.createElement("h2");
    const next = document.createElement("button");
    next.type = "button";
    next.className = "calendar-arrow";
    next.setAttribute("aria-label", "Next month");
    next.textContent = "›";
    heading.append(previous, monthLabel, next);

    const table = document.createElement("table");
    table.className = "calendar-grid";
    const head = table.createTHead().insertRow();
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((day) => {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = day;
        head.appendChild(cell);
    });
    const body = table.createTBody();
    const selectedDate = document.createElement("p");
    selectedDate.className = "calendar-selection";
    selectedDate.setAttribute("aria-live", "polite");

    function drawMonth() {
        monthLabel.textContent = formatMonth(visibleMonth);
        body.replaceChildren();
        const firstWeekday = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1).getDay();
        const daysInMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 0).getDate();
        const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

        for (let index = 0; index < cellCount; index += 7) {
            const row = body.insertRow();
            for (let weekday = 0; weekday < 7; weekday += 1) {
                const day = index + weekday - firstWeekday + 1;
                const cell = row.insertCell();
                if (day < 1 || day > daysInMonth) continue;

                const date = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), day);
                const dateButton = document.createElement("button");
                dateButton.type = "button";
                dateButton.className = "calendar-day";
                dateButton.textContent = String(day);
                dateButton.disabled = date < today;
                dateButton.setAttribute("aria-label", new Intl.DateTimeFormat("en", {
                    dateStyle: "long",
                }).format(date));
                dateButton.addEventListener("click", () => {
                    wrapper.querySelectorAll(".calendar-day.is-selected").forEach((item) => {
                        item.classList.remove("is-selected");
                        item.removeAttribute("aria-pressed");
                    });
                    dateButton.classList.add("is-selected");
                    dateButton.setAttribute("aria-pressed", "true");
                    selectedDate.textContent = `Selected: ${new Intl.DateTimeFormat("en", {
                        dateStyle: "long",
                    }).format(date)}`;
                    onSelect(date);
                    const dateInput = document.querySelector('input[name="pickup_date"]');
                    dateInput?.dispatchEvent(new Event("change", { bubbles: true }));
                });
                cell.appendChild(dateButton);
            }
        }
    }

    previous.addEventListener("click", () => {
        const previousMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
        if (previousMonth.getFullYear() < today.getFullYear()
            || (previousMonth.getFullYear() === today.getFullYear()
                && previousMonth.getMonth() < today.getMonth())) return;
        visibleMonth = previousMonth;
        drawMonth();
    });
    next.addEventListener("click", () => {
        visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
        drawMonth();
    });

    wrapper.append(heading, table, selectedDate);
    container.replaceChildren(wrapper);
    drawMonth();

    const queryDate = new URLSearchParams(window.location.search).get("date");
    if (queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
        const requestedDate = new Date(`${queryDate}T00:00:00`);
        const normalizedDate = [
            requestedDate.getFullYear(),
            String(requestedDate.getMonth() + 1).padStart(2, "0"),
            String(requestedDate.getDate()).padStart(2, "0"),
        ].join("-");
        if (!Number.isNaN(requestedDate.getTime())
            && normalizedDate === queryDate && requestedDate >= today) {
            visibleMonth = new Date(requestedDate.getFullYear(), requestedDate.getMonth(), 1);
            drawMonth();
            const requestedDay = [...wrapper.querySelectorAll(".calendar-day")]
                .find((button) => Number(button.textContent) === requestedDate.getDate());
            if (requestedDay) requestedDay.click();
        }
    }
}

async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
}

function showApiNotice(container, message) {
    if (!container) return;
    const notice = document.createElement("p");
    notice.className = "form-status is-error";
    notice.setAttribute("role", "status");
    notice.textContent = message;
    container.prepend(notice);
}

function vehicleCard(vehicle, className) {
    const card = document.createElement("article");
    card.className = className;
    const name = document.createElement("h3");
    name.className = "manong-rentals1";
    name.textContent = vehicle.name;
    const model = document.createElement("p");
    model.className = "toyota-hi-ace-van";
    model.textContent = vehicle.model;
    const image = document.createElement("img");
    image.className = "van-preview";
    image.src = vehicle.image_path;
    image.alt = `${vehicle.model} vehicle`;
    const capacity = document.createElement("div");
    capacity.className = "vehicle-capacity";
    const icon = document.createElement("img");
    icon.src = "images/human.png";
    icon.alt = "";
    const label = document.createElement("span");
    label.textContent = `${vehicle.capacity} passengers`;
    capacity.append(icon, label);
    card.append(name, model, image, capacity);
    return card;
}

async function loadVehicles() {
    const homeSection = document.querySelector(".fleet-section");
    const bookingForm = document.querySelector('[data-api-form="booking"]');
    const bookingSelect = bookingForm?.querySelector("[data-vehicle-select]");
    const vehicleInfo = document.querySelector(".page-inquire .rectangle-div-information");
    if (!homeSection && !bookingForm && !vehicleInfo) return;
    try {
        const { vehicles } = await requestJson("/api/vehicles");
        if (homeSection) {
            homeSection.querySelectorAll(".rectangle-div, .rectangle-div-2, .rectangle-div-3")
                .forEach((card) => card.remove());
            vehicles.forEach((vehicle) => homeSection.append(vehicleCard(vehicle, "rectangle-div")));
            if (!vehicles.length) showApiNotice(homeSection, "No vehicles are currently available.");
        }

        const bookingCards = document.querySelector(".deal-navigation-buttons");
        if (bookingCards) {
            document.querySelectorAll(".page-make-a-deal .kahon-div, .page-make-a-deal .kahon-div-2, .page-make-a-deal .kahon-div-3")
                .forEach((card) => card.remove());
            vehicles.forEach((vehicle) => bookingCards.before(vehicleCard(vehicle, "kahon-div")));
        }

        if (bookingSelect) {
            bookingSelect.replaceChildren(new Option("Choose a vehicle", ""));
            vehicles.forEach((vehicle) => {
                bookingSelect.add(new Option(
                    `${vehicle.name} — ${vehicle.model} (${vehicle.capacity} passengers)`,
                    String(vehicle.id),
                ));
            });
            bookingSelect.disabled = vehicles.length === 0;
        }

        if (vehicleInfo && vehicles[0]) {
            const name = vehicleInfo.querySelector(".toyota-hi-ace-van");
            const capacity = vehicleInfo.querySelector(".vehicle-capacity span");
            if (name) name.textContent = `${vehicles[0].name} · ${vehicles[0].model}`;
            if (capacity) capacity.textContent = `${vehicles[0].capacity} passengers`;
        }
    } catch (error) {
        homeSection?.querySelectorAll(".rectangle-div, .rectangle-div-2, .rectangle-div-3")
            .forEach((card) => card.remove());
        document.querySelectorAll(".page-make-a-deal .kahon-div, .page-make-a-deal .kahon-div-2, .page-make-a-deal .kahon-div-3")
            .forEach((card) => card.remove());
        showApiNotice(homeSection || bookingForm?.parentElement, error.message);
        if (vehicleInfo) {
            const name = vehicleInfo.querySelector(".toyota-hi-ace-van");
            const capacity = vehicleInfo.querySelector(".vehicle-capacity span");
            if (name) name.textContent = "Fleet details unavailable";
            if (capacity) capacity.textContent = "Check back soon";
        }
        if (bookingSelect) {
            bookingSelect.replaceChildren(new Option("Vehicle list unavailable", ""));
            bookingSelect.disabled = true;
        }
    }
}

function setupAvailabilityCheck(form) {
    const fields = ["vehicle_id", "pickup_date", "pickup_time", "return_date", "return_time"]
        .map((name) => form.elements.namedItem(name));
    const status = form.querySelector("[data-availability-status]");
    if (!status || fields.some((field) => !field)) return;
    let activeController;
    let requestId = 0;
    const check = async () => {
        const [vehicle, pickupDate, pickupTime, returnDate, returnTime] = fields.map((field) => field.value);
        const pickup = form.elements.namedItem("pickup_date");
        const returned = form.elements.namedItem("return_date");
        returned.min = pickup.value || "";
        if (!vehicle || !pickupDate || !pickupTime || !returnDate || !returnTime) {
            status.textContent = "";
            status.classList.remove("is-error");
            return;
        }
        activeController?.abort();
        activeController = new AbortController();
        const currentRequest = ++requestId;
        status.textContent = "Checking vehicle availability…";
        status.classList.remove("is-error");
        const query = new URLSearchParams({
            vehicle_id: vehicle,
            pickup_date: pickupDate,
            pickup_time: pickupTime,
            return_date: returnDate,
            return_time: returnTime,
        });
        try {
            const result = await requestJson(`/api/availability?${query}`, {
                signal: activeController.signal,
            });
            if (currentRequest !== requestId) return;
            status.textContent = result.available
                ? `This vehicle is available for ${result.capacity} passengers. Your request still needs driver confirmation.`
                : "This vehicle is not available for those dates. Choose another vehicle or trip window.";
            status.classList.toggle("is-error", !result.available);
        } catch (error) {
            if (error.name === "AbortError" || currentRequest !== requestId) return;
            status.textContent = error.message;
            status.classList.add("is-error");
        }
    };
    fields.forEach((field) => field.addEventListener("change", check));
}

function setupSubmissionForms() {
    document.querySelectorAll("[data-api-form]").forEach((form) => {
        const type = form.dataset.apiForm;
        const status = form.querySelector("[data-form-status]");
        const button = form.querySelector('button[type="submit"]');
        if (!status || !button) return;
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!form.reportValidity()) return;
            button.disabled = true;
            status.classList.remove("is-error");
            status.textContent = "Submitting securely…";
            try {
                const formData = new FormData(form);
                const options = type === "application"
                    ? { method: "POST", body: formData }
                    : {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(Object.fromEntries(formData.entries())),
                    };
                const endpoint = {
                    booking: "/api/bookings",
                    inquiry: "/api/inquiries",
                    application: "/api/applications",
                }[type];
                const result = await requestJson(endpoint, options);
                if (type === "booking") {
                    status.textContent = `Request ${result.reference} was saved. It is pending until the driver confirms availability and pricing.`;
                } else if (type === "inquiry") {
                    status.textContent = "Your message was saved. Thank you for contacting MJV Transport.";
                } else {
                    status.textContent = "Your application and documents were submitted successfully.";
                }
                form.reset();
            } catch (error) {
                status.textContent = error.message;
                status.classList.add("is-error");
            } finally {
                button.disabled = false;
            }
        });
    });
}

document.addEventListener("DOMContentLoaded", () => {
    const page = window.location.pathname.split("/").pop().replace(".html", "") || "index";
    document.body.classList.add(`page-${page}`);

    const nav = document.getElementById("navPills");
    const navigationTarget = {
        "contact-manong": "/contact-us.html",
        "make-a-deal": "/inquire.html",
    }[page] || window.location.pathname;
    nav?.querySelectorAll("a").forEach((link) => {
        if (new URL(link.href).pathname === navigationTarget) {
            link.setAttribute("aria-current", "page");
        }
    });
    if (page === "index") {
        document.querySelector('.icon-button[href="index.html"]')?.setAttribute("aria-current", "page");
    }
    const menuButton = document.querySelector(".hamburger-menu");
    if (nav && menuButton) {
        menuButton.setAttribute("aria-label", "Toggle navigation");
        menuButton.setAttribute("aria-controls", "navPills");
        menuButton.setAttribute("aria-expanded", "false");
        menuButton.addEventListener("click", toggleMenu);
        nav.addEventListener("click", (event) => {
            if (event.target.closest("a")) {
                nav.classList.remove("is-open");
                menuButton.setAttribute("aria-expanded", "false");
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && nav.classList.contains("is-open")) {
                nav.classList.remove("is-open");
                menuButton.setAttribute("aria-expanded", "false");
                menuButton.focus();
            }
        });
    }

    document.querySelectorAll(".calendar, .table-wrap").forEach((container) => {
        renderCalendar(container, new Date(), (date) => {
            const formattedDate = [
                date.getFullYear(),
                String(date.getMonth() + 1).padStart(2, "0"),
                String(date.getDate()).padStart(2, "0"),
            ].join("-");
            const dateInput = document.querySelector('input[name="pickup_date"]');
            if (dateInput) dateInput.value = formattedDate;

            const requestLink = container.querySelector(".request-date-link")
                || document.createElement("a");
            requestLink.className = "request-date-link";
            requestLink.href = `make-a-deal.html?date=${formattedDate}`;
            requestLink.textContent = "Request this date";
            if (!requestLink.isConnected) container.appendChild(requestLink);
        });
    });

    const dateInput = document.querySelector('input[name="pickup_date"]');
    if (dateInput) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        dateInput.min = [
            today.getFullYear(),
            String(today.getMonth() + 1).padStart(2, "0"),
            String(today.getDate()).padStart(2, "0"),
        ].join("-");
        const queryDate = new URLSearchParams(window.location.search).get("date");
        if (queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate)) {
            const requestedDate = new Date(`${queryDate}T00:00:00`);
            const normalizedDate = [
                requestedDate.getFullYear(),
                String(requestedDate.getMonth() + 1).padStart(2, "0"),
                String(requestedDate.getDate()).padStart(2, "0"),
            ].join("-");
            if (requestedDate >= today && !Number.isNaN(requestedDate.getTime())
                && normalizedDate === queryDate) {
                dateInput.value = queryDate;
            }
            const returnDateInput = document.querySelector('input[name="return_date"]');
            if (returnDateInput) {
                const pickupDateInput = document.querySelector('input[name="pickup_date"]');
                returnDateInput.min = pickupDateInput?.value || "";
                pickupDateInput?.addEventListener("change", () => {
                    returnDateInput.min = pickupDateInput.value;
                    if (returnDateInput.value && returnDateInput.value < pickupDateInput.value) {
                        returnDateInput.value = "";
                    }
                });
            }
        }
    }
    const birthdayInput = document.querySelector('input[name="birthday"]');
    if (birthdayInput) {
        const today = new Date();
        birthdayInput.max = [
            today.getFullYear(),
            String(today.getMonth() + 1).padStart(2, "0"),
            String(today.getDate()).padStart(2, "0"),
        ].join("-");
    }

    loadVehicles();
    const bookingForm = document.querySelector('[data-api-form="booking"]');
    if (bookingForm) setupAvailabilityCheck(bookingForm);
    setupSubmissionForms();

    document.querySelectorAll("video").forEach((video) => {
        const image = document.createElement("img");
        image.src = "images/van.png";
        image.alt = "Toyota HiAce van";
        image.className = "van-preview";
        video.replaceWith(image);
    });

    const year = document.querySelector(".charles-jansen-2024");
    if (year) year.textContent = `© MJV Transport ${new Date().getFullYear()}`;
});
