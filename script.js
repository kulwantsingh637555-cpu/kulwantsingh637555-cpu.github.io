/* =========================================================
   VEGGIESTOCK - FINAL FIX
   Works locally AND uses Firestore when available.
   ========================================================= */

let items = [];
let invoiceItems = JSON.parse(localStorage.getItem("invoiceItems") || "[]");
let cloudOnline = false;
let cloudUnsubscribe = null;
const LOCAL_KEY = "vegetableItems_backup";

/* ---------------- START ---------------- */

document.addEventListener("DOMContentLoaded", () => {
    setTodayDate();
    bindNavigation();
    bindSearchAndFilter();
    loadLocalBackup();
    renderTable();
    renderInvoice();
    updateDashboard();
    connectCloud();
});

/* ---------------- NAVIGATION ---------------- */

function bindNavigation() {
    document.querySelectorAll(".nav-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const target = btn.getAttribute("data-section");
            if (target) showSection(target);
        });
    });
}

function showSection(sectionName) {
    document.querySelectorAll(".section").forEach(s => {
        s.classList.remove("active-section");
    });

    const section = document.getElementById(sectionName);
    if (section) section.classList.add("active-section");

    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.remove("active");
    });

    const activeBtn = document.querySelector(`.nav-btn[data-section="${sectionName}"]`);
    if (activeBtn) activeBtn.classList.add("active");

    if (sectionName === "invoice") renderInvoice();
}

/* ---------------- FIREBASE ---------------- */

function setStatus(text, ok=false) {
    const el = document.getElementById("firebaseStatus");
    if (!el) return;
    el.innerText = text;
    el.classList.toggle("firebase-online", ok);
}

function connectCloud() {
    if (!window.db) {
        setStatus("🟡 Local Mode");
        return;
    }

    try {
        const ref = window.db.collection("vegetableItems");

        // No orderBy: avoids missing-field/index problems with older documents.
        cloudUnsubscribe = ref.onSnapshot(
            snapshot => {
                items = snapshot.docs.map(d => ({
                    id: d.id,
                    ...d.data()
                }));

                items.sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

                cloudOnline = true;
                saveLocalBackup();
                setStatus("🟢 Cloud Sync ON", true);
                renderTable();
                updateDashboard();
            },
            error => {
                cloudOnline = false;
                console.error("Firestore error:", error);
                setStatus("🟡 Local Mode");
                loadLocalBackup();
                renderTable();
                updateDashboard();
            }
        );
    } catch (error) {
        cloudOnline = false;
        console.error(error);
        setStatus("🟡 Local Mode");
    }
}

/* ---------------- LOCAL BACKUP ---------------- */

function loadLocalBackup() {
    try {
        const saved = JSON.parse(localStorage.getItem(LOCAL_KEY) || "[]");
        if (Array.isArray(saved) && saved.length && !cloudOnline) items = saved;
    } catch(e) {
        console.error(e);
    }
}

function saveLocalBackup() {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(items));
}

/* ---------------- DATE ---------------- */

function setTodayDate() {
    const today = new Date();
    const dateText = today.toLocaleDateString("en-IN", {
        day: "2-digit", month: "2-digit", year: "numeric"
    });

    const todayDate = document.getElementById("todayDate");
    if (todayDate) todayDate.innerText = dateText;

    const invoiceDate = document.getElementById("invoiceDate");
    if (invoiceDate) invoiceDate.innerText = "Date: " + dateText;
}

/* ---------------- SEARCH / FILTER ---------------- */

function bindSearchAndFilter() {
    const search = document.getElementById("searchInput");
    const filter = document.getElementById("categoryFilter");

    if (search) search.addEventListener("input", renderTable);
    if (filter) filter.addEventListener("change", renderTable);
}

/* ---------------- MODAL ---------------- */

function openAddModal() {
    const modal = document.getElementById("itemModal");
    if (!modal) return;

    document.getElementById("modalTitle").innerText = "Add Vegetable";
    document.getElementById("editIndex").value = "";
    document.getElementById("itemName").value = "";
    document.getElementById("itemCategory").value = "Vegetable";
    document.getElementById("itemDate").value = new Date().toISOString().slice(0,10);
    document.getElementById("stockIn").value = "";
    document.getElementById("stockOut").value = "";
    document.getElementById("buyPrice").value = "";
    document.getElementById("sellPrice").value = "";
    modal.classList.add("show");
}

function closeModal() {
    const modal = document.getElementById("itemModal");
    if (modal) modal.classList.remove("show");
}

/* ---------------- SAVE ---------------- */

async function saveItem() {
    const item = {
        name: document.getElementById("itemName").value.trim(),
        category: document.getElementById("itemCategory").value,
        date: document.getElementById("itemDate").value,
        stockIn: Number(document.getElementById("stockIn").value) || 0,
        stockOut: Number(document.getElementById("stockOut").value) || 0,
        buyPrice: Number(document.getElementById("buyPrice").value) || 0,
        sellPrice: Number(document.getElementById("sellPrice").value) || 0
    };

    const editId = document.getElementById("editIndex").value;

    if (!item.name) return alert("Vegetable name enter karein.");
    if (!item.date) return alert("Date select karein.");
    if (item.stockIn < 0 || item.stockOut < 0) return alert("Stock negative nahi ho sakta.");
    if (item.buyPrice < 0 || item.sellPrice < 0) return alert("Price negative nahi ho sakta.");

    try {
        if (cloudOnline && window.db) {
            if (editId) {
                await window.db.collection("vegetableItems").doc(editId).update(item);
            } else {
                item.createdAt = Date.now();
                await window.db.collection("vegetableItems").add(item);
            }
            closeModal();
            return;
        }

        // Local fallback: buttons still work if Firestore is unavailable.
        if (editId) {
            const index = items.findIndex(x => x.id === editId);
            if (index >= 0) items[index] = { ...items[index], ...item };
        } else {
            items.push({ ...item, id: "local_" + Date.now(), createdAt: Date.now() });
        }

        saveLocalBackup();
        renderTable();
        updateDashboard();
        closeModal();
        alert("Item local inventory me save ho gaya. Firebase connect hone par cloud sync hoga.");
    } catch(error) {
        console.error(error);

        // If cloud permission/network fails, save locally instead of breaking the app.
        cloudOnline = false;
        setStatus("🟡 Local Mode");

        if (editId) {
            const index = items.findIndex(x => x.id === editId);
            if (index >= 0) items[index] = { ...items[index], ...item };
        } else {
            items.push({ ...item, id: "local_" + Date.now(), createdAt: Date.now() });
        }

        saveLocalBackup();
        renderTable();
        updateDashboard();
        closeModal();

        alert("Firebase access nahi mila, isliye item local backup me save kar diya gaya.");
    }
}

/* ---------------- STOCK ---------------- */

function getCurrentStock(item) {
    return Math.max(0, Number(item.stockIn || 0) - Number(item.stockOut || 0));
}

function getStockValue(item) {
    return getCurrentStock(item) * Number(item.buyPrice || 0);
}

/* ---------------- TABLE ---------------- */

function renderTable() {
    const table = document.getElementById("inventoryTable");
    if (!table) return;

    const search = (document.getElementById("searchInput")?.value || "").toLowerCase().trim();
    const category = document.getElementById("categoryFilter")?.value || "";

    const filtered = items.filter(item => {
        const nameMatch = String(item.name || "").toLowerCase().includes(search);
        const categoryMatch = !category || item.category === category;
        return nameMatch && categoryMatch;
    });

    if (!filtered.length) {
        table.innerHTML = `<tr><td colspan="11">No items found. Add Item button se vegetable add karein.</td></tr>`;
        return;
    }

    table.innerHTML = filtered.map((item, i) => `
        <tr>
            <td>${i + 1}</td>
            <td>${formatDate(item.date)}</td>
            <td><strong>${escapeHTML(item.name)}</strong></td>
            <td>${escapeHTML(item.category || "")}</td>
            <td>${Number(item.stockIn || 0)} KG</td>
            <td>${Number(item.stockOut || 0)} KG</td>
            <td><strong>${getCurrentStock(item)} KG</strong></td>
            <td>₹${Number(item.buyPrice || 0)}</td>
            <td>₹${Number(item.sellPrice || 0)}</td>
            <td>₹${getStockValue(item)}</td>
            <td>
                <button class="edit-btn" onclick="editItem('${item.id}')">✏️</button>
                <button class="delete-btn" onclick="deleteItem('${item.id}')">🗑️</button>
                <button class="invoice-btn" onclick="addToInvoice('${item.id}')">🧾 Invoice</button>
            </td>
        </tr>
    `).join("");
}

/* ---------------- EDIT / DELETE ---------------- */

function editItem(id) {
    const item = items.find(x => x.id === id);
    if (!item) return;

    document.getElementById("modalTitle").innerText = "Edit Vegetable";
    document.getElementById("editIndex").value = id;
    document.getElementById("itemName").value = item.name || "";
    document.getElementById("itemCategory").value = item.category || "Vegetable";
    document.getElementById("itemDate").value = item.date || "";
    document.getElementById("stockIn").value = item.stockIn ?? 0;
    document.getElementById("stockOut").value = item.stockOut ?? 0;
    document.getElementById("buyPrice").value = item.buyPrice ?? 0;
    document.getElementById("sellPrice").value = item.sellPrice ?? 0;
    document.getElementById("itemModal").classList.add("show");
}

async function deleteItem(id) {
    const item = items.find(x => x.id === id);
    if (!item) return;
    if (!confirm(`Delete ${item.name}?`)) return;

    try {
        if (cloudOnline && window.db && !String(id).startsWith("local_")) {
            await window.db.collection("vegetableItems").doc(id).delete();
        } else {
            items = items.filter(x => x.id !== id);
            saveLocalBackup();
            renderTable();
            updateDashboard();
        }
    } catch(error) {
        console.error(error);
        alert("Delete nahi hua. Firebase Rules/connection check karein.");
    }
}

/* ---------------- DASHBOARD ---------------- */

function updateDashboard() {
    const totalStock = items.reduce((sum, x) => sum + getCurrentStock(x), 0);
    const stockValue = items.reduce((sum, x) => sum + getStockValue(x), 0);
    const categories = new Set(items.map(x => x.category).filter(Boolean));

    const a = document.getElementById("totalItems");
    const b = document.getElementById("totalStock");
    const c = document.getElementById("stockValue");
    const d = document.getElementById("totalCategories");

    if (a) a.innerText = items.length;
    if (b) b.innerText = totalStock;
    if (c) c.innerText = stockValue;
    if (d) d.innerText = categories.size;
}

/* ---------------- INVOICE ---------------- */

function addToInvoice(id) {
    const item = items.find(x => x.id === id);
    if (!item) return alert("Item nahi mila.");

    const available = getCurrentStock(item);
    if (available <= 0) return alert(`${item.name} ka stock available nahi hai.`);

    const existing = invoiceItems.find(x => x.itemId === id);

    if (existing) {
        if (existing.quantity >= available) {
            return alert(`Available stock: ${available} KG`);
        }
        existing.quantity++;
    } else {
        invoiceItems.push({
            itemId: id,
            name: item.name,
            quantity: 1,
            price: Number(item.sellPrice || 0)
        });
    }

    saveInvoice();
    renderInvoice();
    showSection("invoice");
}

function renderInvoice() {
    const table = document.getElementById("invoiceTable");
    if (!table) return;

    if (!invoiceItems.length) {
        table.innerHTML = `<tr><td colspan="4">Invoice me abhi koi item nahi hai.</td></tr>`;
        const total = document.getElementById("invoiceTotal");
        if (total) total.innerText = "0";
        return;
    }

    let grand = 0;

    table.innerHTML = invoiceItems.map((x, i) => {
        const line = Number(x.quantity) * Number(x.price);
        grand += line;

        return `
            <tr>
                <td>${escapeHTML(x.name)}</td>
                <td><input type="number" min="1" value="${x.quantity}"
                    onchange="changeInvoiceQty(${i}, this.value)" style="width:80px"></td>
                <td>₹${x.price}</td>
                <td>₹${line}</td>
            </tr>
        `;
    }).join("");

    const total = document.getElementById("invoiceTotal");
    if (total) total.innerText = grand;
}

function changeInvoiceQty(index, value) {
    const qty = Number(value);
    if (!qty || qty <= 0) {
        invoiceItems.splice(index, 1);
    } else {
        const inv = invoiceItems[index];
        const stock = items.find(x => x.id === inv.itemId);
        if (stock && qty > getCurrentStock(stock)) {
            alert(`Available stock: ${getCurrentStock(stock)} KG`);
            renderInvoice();
            return;
        }
        inv.quantity = qty;
    }

    saveInvoice();
    renderInvoice();
}

function saveInvoice() {
    localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));
}

function printInvoice() {
    if (!invoiceItems.length) {
        alert("Invoice me item add karein.");
        return;
    }
    window.print();
}

/* ---------------- HELPERS ---------------- */

function formatDate(value) {
    if (!value) return "";
    const d = new Date(value);
    return isNaN(d) ? value : d.toLocaleDateString("en-IN");
}

function escapeHTML(value) {
    return String(value ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
}

/* ---------------- GLOBALS FOR EXISTING HTML ---------------- */

window.showSection = showSection;
window.openAddModal = openAddModal;
window.closeModal = closeModal;
window.saveItem = saveItem;
window.editItem = editItem;
window.deleteItem = deleteItem;
window.addToInvoice = addToInvoice;
window.changeInvoiceQty = changeInvoiceQty;
window.printInvoice = printInvoice;
window.renderTable = renderTable;
window.renderInvoice = renderInvoice;
