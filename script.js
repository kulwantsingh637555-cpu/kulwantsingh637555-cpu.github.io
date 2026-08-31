/* =====================================================
   SMART VEGETABLE STORE
   Firestore = shared inventory source of truth
   LocalStorage = offline cache / first-time migration only
   ===================================================== */

import { db, auth } from "./firebase.js";
import {
    collection, doc, setDoc, deleteDoc, getDocs, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

let items = JSON.parse(localStorage.getItem("vegetableItems") || "[]");
let invoiceItems = JSON.parse(localStorage.getItem("invoiceItems") || "[]");
let unsubscribeInventory = null;
let cloudReady = false;
let toastTimer = null;

const INVENTORY_COLLECTION = "vegetableItems";

/* ================= PAGE LOAD ================= */

document.addEventListener("DOMContentLoaded", async () => {
    setTodayDate();
    renderTable();
    updateDashboard();
    renderInvoice();
    await connectCloudInventory();
});

/* ================= CLOUD SYNC ================= */

async function connectCloudInventory() {
    setSyncStatus("⏳ Connecting to cloud...", false);

    try {
        await signInAnonymously(auth);

        const snap = await getDocs(collection(db, INVENTORY_COLLECTION));

        // First device: migrate existing local inventory only if cloud is empty.
        if (snap.empty && items.length > 0) {
            for (const item of items) {
                const id = item.id || makeId();
                item.id = id;
                await setDoc(doc(db, INVENTORY_COLLECTION, id), sanitizeItem(item));
            }
        }

        // If cloud already has data, cloud is authoritative.
        if (!snap.empty) {
            items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            cacheItems();
            renderTable();
            updateDashboard();
        }

        subscribeToInventory();
        cloudReady = true;
        setSyncStatus("☁️ Cloud sync ON", true);
    } catch (error) {
        console.error("Firebase connection error:", error);
        cloudReady = false;
        setSyncStatus("⚠️ Cloud sync unavailable", false);
        showFirebaseError(error);

    }
}

function subscribeToInventory() {
    if (unsubscribeInventory) unsubscribeInventory();

    unsubscribeInventory = onSnapshot(
        collection(db, INVENTORY_COLLECTION),
        snapshot => {
            items = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
            }));

            cacheItems();
            renderTable();
            updateDashboard();
            renderInvoice();

            setSyncStatus("☁️ Cloud sync ON", true);
        },
        error => {
            console.error("Inventory listener error:", error);
            setSyncStatus("⚠️ Sync error", false);
        }
    );
}

async function saveItemToCloud(item) {
    if (!auth.currentUser) {
        throw new Error("Cloud login not ready");
    }

    const id = item.id || makeId();
    const clean = sanitizeItem({ ...item, id });

    await setDoc(doc(db, INVENTORY_COLLECTION, id), clean);
    return id;
}

async function deleteItemFromCloud(id) {
    await deleteDoc(doc(db, INVENTORY_COLLECTION, id));
}

function sanitizeItem(item) {
    return {
        name: String(item.name || "").trim(),
        category: String(item.category || "Vegetable"),
        date: String(item.date || ""),
        stockIn: Number(item.stockIn) || 0,
        stockOut: Number(item.stockOut) || 0,
        buyPrice: Number(item.buyPrice) || 0,
        sellPrice: Number(item.sellPrice) || 0,
        updatedAt: Date.now()
    };
}

function showFirebaseError(error) {
    const code = error?.code || "unknown";
    console.error("Firebase error code:", code, "message:", error?.message || error);

    let message = "Firebase connect नहीं हुआ।";
    if (code === "auth/operation-not-allowed") {
        message = "Firebase में Anonymous Authentication OFF है। इसे ON करें।";
    } else if (code === "auth/unauthorized-domain") {
        message = "GitHub Pages domain Firebase Authentication में Authorized Domains में add करें।";
    } else if (code === "permission-denied" || code === "firestore/permission-denied") {
        message = "Firestore Rules में signed-in users को read/write permission दें।";
    } else if (code === "failed-precondition") {
        message = "Firestore database अभी create नहीं हुआ है। Firebase में Firestore Database बनाएं।";
    } else if (code === "unavailable") {
        message = "Internet/Firebase connection unavailable है। Internet check करके Retry करें।";
    }
    showToast(message);
}

async function retryCloudSync() {
    await connectCloudInventory();
}

/* ================= DATE ================= */

function setTodayDate() {
    const today = new Date();
    const formattedDate = today.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    });

    const todayDate = document.getElementById("todayDate");
    if (todayDate) todayDate.innerText = formattedDate;

    const invoiceDate = document.getElementById("invoiceDate");
    if (invoiceDate) invoiceDate.innerText = "Date: " + formattedDate;
}

/* ================= SECTION ================= */

function showSection(sectionName) {
    document.querySelectorAll(".section").forEach(section => {
        section.classList.remove("active-section");
    });

    const selectedSection = document.getElementById(sectionName);
    if (selectedSection) selectedSection.classList.add("active-section");

    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.remove("active");
    });

    const navButtons = document.querySelectorAll(".nav-btn");
    const map = { dashboard: 0, inventory: 1, invoice: 2 };

    if (navButtons[map[sectionName]]) {
        navButtons[map[sectionName]].classList.add("active");
    }

    if (sectionName === "inventory") renderTable();
    if (sectionName === "invoice") renderInvoice();

    window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ================= MODAL ================= */

function openAddModal() {
    document.getElementById("modalTitle").innerText = "Add Vegetable";
    document.getElementById("editIndex").value = "";
    document.getElementById("itemName").value = "";
    document.getElementById("itemCategory").value = "Vegetable";
    document.getElementById("itemDate").value = new Date().toISOString().split("T")[0];
    document.getElementById("stockIn").value = "";
    document.getElementById("stockOut").value = "";
    document.getElementById("buyPrice").value = "";
    document.getElementById("sellPrice").value = "";
    document.getElementById("itemModal").classList.add("show");
}

function closeModal() {
    document.getElementById("itemModal").classList.remove("show");
}

/* ================= SAVE ITEM ================= */

async function saveItem() {
    const name = document.getElementById("itemName").value.trim();
    const category = document.getElementById("itemCategory").value;
    const date = document.getElementById("itemDate").value;
    const stockIn = Number(document.getElementById("stockIn").value) || 0;
    const stockOut = Number(document.getElementById("stockOut").value) || 0;
    const buyPrice = Number(document.getElementById("buyPrice").value) || 0;
    const sellPrice = Number(document.getElementById("sellPrice").value) || 0;
    const editIndex = document.getElementById("editIndex").value;

    if (!name) return alert("Please enter vegetable name!");
    if (!date) return alert("Please select date!");
    if (stockIn < 0 || stockOut < 0) return alert("Stock cannot be negative!");
    if (buyPrice < 0 || sellPrice < 0) return alert("Price cannot be negative!");

    // Prevent selling more than available stock.
    if (stockOut > stockIn) {
        return alert("Stock Out, Stock In से ज्यादा नहीं हो सकता!");
    }

    const oldItem = editIndex !== "" ? items[Number(editIndex)] : null;

    const item = {
        id: oldItem?.id || makeId(),
        name,
        category,
        date,
        stockIn,
        stockOut,
        buyPrice,
        sellPrice
    };

    try {
        if (cloudReady && auth.currentUser) {
            await saveItemToCloud(item);
            showToast(oldItem ? "Item updated और cloud में save हो गया।" : "Item cloud में save हो गया।");
        } else {
            items[editIndex !== "" ? Number(editIndex) : items.length] = item;
            cacheItems();
            renderTable();
            updateDashboard();
            showToast("Offline: item इस device पर save हुआ।");
        }

        closeModal();
    } catch (error) {
        console.error(error);
        alert("Item save नहीं हुआ। Firebase/Firestore Rules check करें।");
    }
}

/* ================= LOCAL CACHE ================= */

function cacheItems() {
    localStorage.setItem("vegetableItems", JSON.stringify(items));
}

/* ================= CURRENT STOCK ================= */

function getCurrentStock(item) {
    return Math.max(0, Number(item.stockIn) - Number(item.stockOut));
}

function getStockValue(item) {
    return getCurrentStock(item) * Number(item.buyPrice);
}

/* ================= RENDER TABLE ================= */

function renderTable() {
    const table = document.getElementById("inventoryTable");
    if (!table) return;

    const search = document.getElementById("searchInput")?.value.toLowerCase() || "";
    const category = document.getElementById("categoryFilter")?.value || "";

    const filteredItems = items.filter(item => {
        const matchName = String(item.name || "").toLowerCase().includes(search);
        const matchCategory = category === "" || item.category === category;
        return matchName && matchCategory;
    });

    table.innerHTML = "";

    if (filteredItems.length === 0) {
        table.innerHTML = `<tr><td colspan="11">No items found</td></tr>`;
        return;
    }

    filteredItems.forEach((item, filteredIndex) => {
        const originalIndex = items.indexOf(item);
        const currentStock = getCurrentStock(item);
        const value = getStockValue(item);

        table.innerHTML += `
            <tr>
                <td>${originalIndex + 1}</td>
                <td>${formatDate(item.date)}</td>
                <td><strong>${escapeHTML(item.name)}</strong></td>
                <td>${escapeHTML(item.category)}</td>
                <td>${Number(item.stockIn) || 0} KG</td>
                <td>${Number(item.stockOut) || 0} KG</td>
                <td><strong>${currentStock} KG</strong></td>
                <td>₹${Number(item.buyPrice) || 0}</td>
                <td>₹${Number(item.sellPrice) || 0}</td>
                <td>₹${value}</td>
                <td>
                    <button class="edit-btn" onclick="editItem(${originalIndex})">✏️</button>
                    <button class="delete-btn" onclick="deleteItem(${originalIndex})">🗑️</button>
                    <button class="invoice-btn" onclick="addToInvoice(${originalIndex})">🧾 Invoice</button>
                </td>
            </tr>`;
    });
}

/* ================= EDIT ITEM ================= */

function editItem(index) {
    const item = items[index];
    if (!item) return;

    document.getElementById("modalTitle").innerText = "Edit Vegetable";
    document.getElementById("editIndex").value = index;
    document.getElementById("itemName").value = item.name || "";
    document.getElementById("itemCategory").value = item.category || "Vegetable";
    document.getElementById("itemDate").value = item.date || "";
    document.getElementById("stockIn").value = item.stockIn ?? 0;
    document.getElementById("stockOut").value = item.stockOut ?? 0;
    document.getElementById("buyPrice").value = item.buyPrice ?? 0;
    document.getElementById("sellPrice").value = item.sellPrice ?? 0;
    document.getElementById("itemModal").classList.add("show");
}

/* ================= DELETE ITEM ================= */

async function deleteItem(index) {
    const item = items[index];
    if (!item) return;

    if (!confirm(`Delete ${item.name}?`)) return;

    try {
        if (cloudReady && auth.currentUser && item.id) {
            await deleteItemFromCloud(item.id);
            showToast("Item cloud से delete हो गया।");
        } else {
            items.splice(index, 1);
            cacheItems();
            renderTable();
            updateDashboard();
            showToast("Item delete हो गया।");
        }
    } catch (error) {
        console.error(error);
        alert("Delete नहीं हुआ। Firebase/Firestore Rules check करें।");
    }
}

/* ================= DASHBOARD ================= */

function updateDashboard() {
    let totalStock = 0;
    let stockValue = 0;
    const categories = new Set();

    items.forEach(item => {
        totalStock += getCurrentStock(item);
        stockValue += getStockValue(item);
        categories.add(item.category);
    });

    const totalItems = document.getElementById("totalItems");
    const totalStockElement = document.getElementById("totalStock");
    const stockValueElement = document.getElementById("stockValue");
    const totalCategories = document.getElementById("totalCategories");

    if (totalItems) totalItems.innerText = items.length;
    if (totalStockElement) totalStockElement.innerText = totalStock;
    if (stockValueElement) stockValueElement.innerText = stockValue.toLocaleString("en-IN");
    if (totalCategories) totalCategories.innerText = categories.size;
}

/* ================= INVOICE ================= */

function addToInvoice(index) {
    const item = items[index];
    if (!item) return;

    if (getCurrentStock(item) <= 0) {
        return alert("इस item का current stock 0 है।");
    }

    const existing = invoiceItems.find(invoiceItem => invoiceItem.name === item.name);

    if (existing) existing.quantity += 1;
    else invoiceItems.push({
        name: item.name,
        quantity: 1,
        price: Number(item.sellPrice) || 0
    });

    saveInvoice();
    renderInvoice();
    showToast(`${item.name} invoice में add हो गया।`);
    showSection("invoice");
}

function renderInvoice() {
    const table = document.getElementById("invoiceTable");
    if (!table) return;

    table.innerHTML = "";
    let grandTotal = 0;

    if (invoiceItems.length === 0) {
        table.innerHTML = `<tr><td colspan="4">Invoice में अभी कोई item नहीं है।</td></tr>`;
    }

    invoiceItems.forEach((item, index) => {
        const total = Number(item.quantity) * Number(item.price);
        grandTotal += total;

        table.innerHTML += `
            <tr>
                <td>${escapeHTML(item.name)}</td>
                <td>
                    <input type="number" min="1" value="${item.quantity}"
                        onchange="changeInvoiceQty(${index}, this.value)"
                        style="width:80px">
                </td>
                <td>₹${Number(item.price) || 0}</td>
                <td>₹${total}</td>
            </tr>`;
    });

    const invoiceTotal = document.getElementById("invoiceTotal");
    if (invoiceTotal) invoiceTotal.innerText = grandTotal.toLocaleString("en-IN");
}

function changeInvoiceQty(index, quantity) {
    quantity = Number(quantity);

    if (quantity <= 0) invoiceItems.splice(index, 1);
    else invoiceItems[index].quantity = quantity;

    saveInvoice();
    renderInvoice();
}

function saveInvoice() {
    localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));
}

function printInvoice() {
    if (invoiceItems.length === 0) {
        alert("पहले invoice में item add करें!");
        return;
    }
    window.print();
}

/* ================= HELPERS ================= */

function formatDate(dateString) {
    if (!dateString) return "";
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("en-IN");
}

function escapeHTML(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function makeId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return "item-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

function setSyncStatus(message, ok) {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    el.textContent = message;
    el.style.background = ok ? "rgba(255,255,255,.14)" : "rgba(180,40,40,.28)";
}

function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;

    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

/* Inline onclick in index.html needs module functions exposed globally. */
Object.assign(window, {
    showSection,
    openAddModal,
    closeModal,
    saveItem,
    renderTable,
    editItem,
    deleteItem,
    addToInvoice,
    renderInvoice,
    changeInvoiceQty,
    printInvoice,
    retryCloudSync
});
