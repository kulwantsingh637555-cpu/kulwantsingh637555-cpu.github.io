import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
  getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDM_2MYad1LPpEBPEQhkhZKsdy20WpQoww",
  authDomain: "smart-hotel-veggis-store.firebaseapp.com",
  projectId: "smart-hotel-veggis-store",
  storageBucket: "smart-hotel-veggis-store.firebasestorage.app",
  messagingSenderId: "313226803394",
  appId: "1:313226803394:web:64915703ffb27a673c635b",
  measurementId: "G-CMXXCF84QN"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const inventoryCollection = collection(db, "vegetableItems");
const invoiceCollection = collection(db, "invoiceItems");

/* =====================================================
iou
   VEGETABLE INVENTORY MANAGEMENT SYSTEM
   ===================================================== */


/* ================= DATA ================= */

// Local Storage से inventory data निकालना
let items = JSON.parse(
    localStorage.getItem("vegetableItems")
) || [];

// Invoice items
let invoiceItems = JSON.parse(
    localStorage.getItem("invoiceItems")
) || [];


/* ================= FIREBASE SYNC ================= */

async function loadInventoryFromFirebase() {
    try {
        const snapshot = await getDocs(inventoryCollection);
        const remote = [];
        snapshot.forEach(d => remote.push({ ...d.data(), firebaseId: d.id }));

        if (remote.length > 0) {
            items = remote;
            saveToLocalStorage();
        } else if (items.length > 0) {
            // First-time migration: upload old local inventory once.
            const oldItems = items.map(x => ({...x}));
            for (const item of oldItems) {
                delete item.firebaseId;
                const d = await addDoc(inventoryCollection, item);
                item.firebaseId = d.id;
            }
            items = oldItems;
            saveToLocalStorage();
        }
    } catch (error) {
        console.error("Firebase inventory load error:", error);
    }
}

async function loadInvoicesFromFirebase() {
    try {
        const snapshot = await getDocs(invoiceCollection);
        const remote = [];
        snapshot.forEach(d => remote.push({ ...d.data(), firebaseId: d.id }));
        if (remote.length > 0) {
            invoiceItems = remote;
            saveInvoiceLocalOnly();
        }
    } catch (error) {
        console.error("Firebase invoice load error:", error);
    }
}

function saveInvoiceLocalOnly() {
    localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));
}

/* ================= PAGE LOAD ================= */

document.addEventListener("DOMContentLoaded", async function () {
    setTodayDate();
    await loadInventoryFromFirebase();
    await loadInvoicesFromFirebase();
    renderTable();
    updateDashboard();
    renderInvoice();
});


/* ================= DATE ================= */

function setTodayDate() {

    const today = new Date();

    const formattedDate = today.toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    });

    const todayDate = document.getElementById("todayDate");

    if (todayDate) {
        todayDate.innerText = formattedDate;
    }

    const invoiceDate = document.getElementById("invoiceDate");

    if (invoiceDate) {
        invoiceDate.innerText =
            "Date: " + formattedDate;
    }
}


/* ================= SECTION ================= */

function showSection(sectionName) {

    // सभी sections hide करें
    document.querySelectorAll(".section").forEach(section => {
        section.classList.remove("active-section");
    });

    // selected section show करें
    const selectedSection =
        document.getElementById(sectionName);

    if (selectedSection) {
        selectedSection.classList.add("active-section");
    }


    // सभी navigation buttons से active हटाएँ
    document.querySelectorAll(".nav-btn").forEach(btn => {
        btn.classList.remove("active");
    });


    // सही navigation button active करें
    const navButtons =
        document.querySelectorAll(".nav-btn");

    if (sectionName === "dashboard" && navButtons[0]) {
        navButtons[0].classList.add("active");
    }

    if (sectionName === "inventory" && navButtons[1]) {
        navButtons[1].classList.add("active");
    }

    if (sectionName === "invoice" && navButtons[2]) {
        navButtons[2].classList.add("active");

        renderInvoice();
    }
}


/* ================= MODAL ================= */

function openAddModal() {

    document.getElementById("modalTitle").innerText =
        "Add Vegetable";

    document.getElementById("editIndex").value = "";

    document.getElementById("itemName").value = "";

    document.getElementById("itemCategory").value =
        "Vegetable";

    document.getElementById("itemDate").value =
        new Date().toISOString().split("T")[0];

    document.getElementById("stockIn").value = "";

    document.getElementById("stockOut").value = "";

    document.getElementById("buyPrice").value = "";

    document.getElementById("sellPrice").value = "";


    document.getElementById("itemModal")
        .classList.add("show");
}


/* ================= CLOSE MODAL ================= */

function closeModal() {

    document.getElementById("itemModal")
        .classList.remove("show");
}


/* ================= SAVE ITEM ================= */

async function saveItem() {

    const name =
        document.getElementById("itemName").value.trim();

    const category =
        document.getElementById("itemCategory").value;

    const date =
        document.getElementById("itemDate").value;

    const stockIn =
        Number(
            document.getElementById("stockIn").value
        ) || 0;

    const stockOut =
        Number(
            document.getElementById("stockOut").value
        ) || 0;

    const buyPrice =
        Number(
            document.getElementById("buyPrice").value
        ) || 0;

    const sellPrice =
        Number(
            document.getElementById("sellPrice").value
        ) || 0;

    const editIndex =
        document.getElementById("editIndex").value;


    /* ================= VALIDATION ================= */

    if (name === "") {

        alert("Please enter vegetable name!");

        return;
    }


    if (date === "") {

        alert("Please select date!");

        return;
    }


    if (stockIn < 0 || stockOut < 0) {

        alert("Stock cannot be negative!");

        return;
    }


    if (buyPrice < 0 || sellPrice < 0) {

        alert("Price cannot be negative!");

        return;
    }


    /* ================= ITEM OBJECT ================= */

    const item = {

        name: name,

        category: category,

        date: date,

        stockIn: stockIn,

        stockOut: stockOut,

        buyPrice: buyPrice,

        sellPrice: sellPrice

    };


    /* ================= FIREBASE SAVE ================= */

    try {
        if (editIndex !== "") {
            const index = Number(editIndex);
            const oldItem = items[index];

            if (oldItem?.firebaseId) {
                await updateDoc(doc(db, "vegetableItems", oldItem.firebaseId), item);
                item.firebaseId = oldItem.firebaseId;
            } else {
                const newDoc = await addDoc(inventoryCollection, item);
                item.firebaseId = newDoc.id;
            }

            items[index] = item;
            alert("Item updated successfully and synced to Firebase!");
        } else {
            const newDoc = await addDoc(inventoryCollection, item);
            item.firebaseId = newDoc.id;
            items.push(item);
            alert("Item added successfully and synced to Firebase!");
        }

        saveToLocalStorage();
        renderTable();
        updateDashboard();
        renderInvoice();
        closeModal();
    } catch (error) {
        console.error("Firebase save error:", error);
        alert("Firebase में save नहीं हुआ। Firestore Rules और internet connection check करें।");
    }

}


/* ================= LOCAL STORAGE ================= */

function saveToLocalStorage() {

    localStorage.setItem(
        "vegetableItems",
        JSON.stringify(items)
    );
}


/* ================= CURRENT STOCK ================= */

function getCurrentStock(item) {

    return Math.max(
        0,
        Number(item.stockIn) - Number(item.stockOut)
    );

}


/* ================= STOCK VALUE ================= */

function getStockValue(item) {

    return (
        getCurrentStock(item) *
        Number(item.buyPrice)
    );

}


/* ================= RENDER TABLE ================= */

function renderTable() {

    const table =
        document.getElementById("inventoryTable");

    if (!table) {
        return;
    }


    const search =
        document.getElementById("searchInput")
            ?.value
            .toLowerCase() || "";


    const category =
        document.getElementById("categoryFilter")
            ?.value || "";


    /* ================= FILTER ================= */

    const filteredItems = items.filter(item => {

        const matchName =
            item.name
                .toLowerCase()
                .includes(search);

        const matchCategory =
            category === "" ||
            item.category === category;

        return matchName && matchCategory;

    });


    table.innerHTML = "";


    /* ================= NO DATA ================= */

    if (filteredItems.length === 0) {

        table.innerHTML = `
            <tr>
                <td colspan="11">
                    No items found
                </td>
            </tr>
        `;

        return;
    }


    /* ================= TABLE DATA ================= */

    filteredItems.forEach(item => {

        const originalIndex =
            items.indexOf(item);


        const currentStock =
            getCurrentStock(item);


        const value =
            getStockValue(item);


        table.innerHTML += `

            <tr>

                <td>
                    ${originalIndex + 1}
                </td>

                <td>
                    ${formatDate(item.date)}
                </td>

                <td>
                    <strong>
                        ${escapeHTML(item.name)}
                    </strong>
                </td>

                <td>
                    ${escapeHTML(item.category)}
                </td>

                <td>
                    ${item.stockIn} KG
                </td>

                <td>
                    ${item.stockOut} KG
                </td>

                <td>
                    <strong>
                        ${currentStock} KG
                    </strong>
                </td>

                <td>
                    ₹${item.buyPrice}
                </td>

                <td>
                    ₹${item.sellPrice}
                </td>

                <td>
                    ₹${value}
                </td>

                <td>

                    <button
                        class="edit-btn"
                        onclick="editItem(${originalIndex})">
                        ✏️
                    </button>

                    <button
                        class="delete-btn"
                        onclick="deleteItem(${originalIndex})">
                        🗑️
                    </button>

                    <button
                        class="invoice-btn"
                        onclick="addToInvoice(${originalIndex})"
                        title="Add this item to Invoice">
                        🧾 Invoice
                    </button>

                </td>

            </tr>

        `;

    });

}


/* ================= EDIT ITEM ================= */

function editItem(index) {

    const item = items[index];

    if (!item) {
        return;
    }


    document.getElementById("modalTitle").innerText =
        "Edit Vegetable";


    document.getElementById("editIndex").value =
        index;


    document.getElementById("itemName").value =
        item.name;


    document.getElementById("itemCategory").value =
        item.category;


    document.getElementById("itemDate").value =
        item.date;


    document.getElementById("stockIn").value =
        item.stockIn;


    document.getElementById("stockOut").value =
        item.stockOut;


    document.getElementById("buyPrice").value =
        item.buyPrice;


    document.getElementById("sellPrice").value =
        item.sellPrice;


    document.getElementById("itemModal")
        .classList.add("show");

}


/* ================= DELETE ITEM ================= */

async function deleteItem(index) {
    const item = items[index];
    if (!item) return;

    if (!confirm(`Delete ${item.name}?`)) return;

    try {
        if (item.firebaseId) {
            await deleteDoc(doc(db, "vegetableItems", item.firebaseId));
        }

        items.splice(index, 1);
        saveToLocalStorage();
        renderTable();
        updateDashboard();
        renderInvoice();
        alert("Item deleted successfully.");
    } catch (error) {
        console.error("Firebase delete error:", error);
        alert("Item delete नहीं हुआ। Firebase connection/rules check करें।");
    }
}


/* ================= DASHBOARD ================= */

function updateDashboard() {

    let totalStock = 0;

    let stockValue = 0;

    const categories = new Set();


    items.forEach(item => {

        totalStock +=
            getCurrentStock(item);


        stockValue +=
            getStockValue(item);


        categories.add(item.category);

    });


    const totalItems =
        document.getElementById("totalItems");

    const totalStockElement =
        document.getElementById("totalStock");

    const stockValueElement =
        document.getElementById("stockValue");

    const totalCategories =
        document.getElementById("totalCategories");


    if (totalItems) {
        totalItems.innerText =
            items.length;
    }


    if (totalStockElement) {
        totalStockElement.innerText =
            totalStock;
    }


    if (stockValueElement) {
        stockValueElement.innerText =
            stockValue;
    }


    if (totalCategories) {
        totalCategories.innerText =
            categories.size;
    }

}


/* ================= ADD TO INVOICE ================= */

async function addToInvoice(index) {

    const item = items[index];

    if (!item) {
        return;
    }


    const existing =
        invoiceItems.find(
            invoiceItem =>
                invoiceItem.name === item.name
        );


    if (existing) {

        existing.quantity += 1;

    }


    else {

        invoiceItems.push({

            name: item.name,

            quantity: 1,

            price: Number(item.sellPrice)

        });

    }


    await saveInvoice();

    renderInvoice();


    alert(
        `${item.name} invoice में add हो गया।`
    );


    showSection("invoice");

}


/* ================= RENDER INVOICE ================= */

function renderInvoice() {

    const table =
        document.getElementById("invoiceTable");


    if (!table) {
        return;
    }


    table.innerHTML = "";


    let grandTotal = 0;


    /* ================= EMPTY INVOICE ================= */

    if (invoiceItems.length === 0) {

        table.innerHTML = `
            <tr>
                <td colspan="4">
                    Invoice में अभी कोई item नहीं है।
                </td>
            </tr>
        `;

    }


    /* ================= INVOICE ITEMS ================= */

    invoiceItems.forEach((item, index) => {

        const total =
            Number(item.quantity) *
            Number(item.price);


        grandTotal += total;


        table.innerHTML += `

            <tr>

                <td>
                    ${escapeHTML(item.name)}
                </td>

                <td>

                    <input
                        type="number"
                        min="1"
                        value="${item.quantity}"
                        onchange="changeInvoiceQty(
                            ${index},
                            this.value
                        )"
                        style="width:80px"
                    >

                </td>

                <td>
                    ₹${item.price}
                </td>

                <td>
                    ₹${total}
                </td>

            </tr>

        `;

    });


    const invoiceTotal =
        document.getElementById("invoiceTotal");


    if (invoiceTotal) {

        invoiceTotal.innerText =
            grandTotal;

    }

}


/* ================= CHANGE INVOICE QUANTITY ================= */

async function changeInvoiceQty(index, quantity) {

    quantity = Number(quantity);


    if (quantity <= 0) {

        invoiceItems.splice(index, 1);

    }


    else {

        invoiceItems[index].quantity =
            quantity;

    }


    await saveInvoice();

    renderInvoice();

}


/* ================= SAVE INVOICE ================= */

async function saveInvoice() {
    localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));

    try {
        const snapshot = await getDocs(invoiceCollection);

        for (const d of snapshot.docs) {
            await deleteDoc(doc(db, "invoiceItems", d.id));
        }

        for (const invoiceItem of invoiceItems) {
            const data = {
                name: invoiceItem.name,
                quantity: Number(invoiceItem.quantity),
                price: Number(invoiceItem.price)
            };
            const d = await addDoc(invoiceCollection, data);
            invoiceItem.firebaseId = d.id;
        }

        localStorage.setItem("invoiceItems", JSON.stringify(invoiceItems));
    } catch (error) {
        console.error("Firebase invoice save error:", error);
    }
}


/* ================= PRINT INVOICE ================= */

function printInvoice() {

    if (invoiceItems.length === 0) {

        alert(
            "पहले invoice में item add करें!"
        );

        return;
    }


    window.print();

}


/* ================= FORMAT DATE ================= */

function formatDate(dateString) {

    if (!dateString) {
        return "";
    }


    const date =
        new Date(dateString);


    return date.toLocaleDateString("en-IN");

}


/* ================= HTML SECURITY ================= */

function escapeHTML(text) {

    return String(text)

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;")

        .replace(/"/g, "&quot;")

        .replace(/'/g, "&#039;");

}