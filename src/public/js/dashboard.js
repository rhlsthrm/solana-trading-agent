/**
 * dashboard.js - JavaScript functionality for the Solana Trading Agent dashboard
 */

// Initialize dashboard functionality when the DOM is fully loaded
document.addEventListener("DOMContentLoaded", function () {
  initializeCountdown();
  initializeCopyButtons();
  initializeClosePositionButtons();
  loadBalanceHistoryChart();
});

/**
 * Initialize the auto-refresh countdown timer
 */
function initializeCountdown() {
  let seconds = 30;
  const countdownElement = document.getElementById("countdown");

  if (!countdownElement) return;

  function updateCountdown() {
    countdownElement.textContent = seconds;
    if (seconds > 0) {
      seconds -= 1;
      setTimeout(updateCountdown, 1000);
    }
  }

  updateCountdown();
}

/**
 * Initialize functionality for token address copy buttons
 */
function initializeCopyButtons() {
  document.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", function (e) {
      e.preventDefault();
      const address = this.dataset.address;

      // Create a temporary input element to copy the text
      const tempInput = document.createElement("input");
      tempInput.value = address;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand("copy");
      document.body.removeChild(tempInput);

      // Visual feedback
      const originalColor = this.style.color;
      this.style.color = "#10b981"; // Success green

      // Reset back after a short delay
      setTimeout(() => {
        this.style.color = originalColor;
      }, 1000);
    });
  });
}

/**
 * Initialize functionality for close position buttons
 */
function initializeClosePositionButtons() {
  // Handle Close Position buttons
  document.querySelectorAll(".close-position-btn").forEach((button) => {
    button.addEventListener("click", async function (e) {
      e.preventDefault();
      const positionId = this.dataset.positionId;
      const tokenName = this.dataset.tokenName;

      // Confirm with the user before closing the position
      if (
        !confirm(
          `Are you sure you want to close your position in ${tokenName}? This will sell your tokens.`
        )
      ) {
        return;
      }

      // Disable the button and show loading state
      this.disabled = true;
      this.textContent = "Closing...";

      try {
        // Make an API call to close the position
        const response = await fetch(`/api/position/close/${positionId}`, {
          method: "POST",
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success) {
            alert(
              `Position successfully closed! Profit/Loss: $${result.profitLoss.toFixed(
                2
              )}`
            );
            // Refresh the page to show updated data
            window.location.reload();
          } else {
            alert(`Error closing position: ${result.error}`);
            // Re-enable the button
            this.disabled = false;
            this.textContent = "Close Position";
          }
        } else {
          alert("Error communicating with server. Please try again.");
          // Re-enable the button
          this.disabled = false;
          this.textContent = "Close Position";
        }
      } catch (error) {
        console.error("Error closing position:", error);
        alert("An unexpected error occurred. Please try again.");
        // Re-enable the button
        this.disabled = false;
        this.textContent = "Close Position";
      }
    });
  });

  // Handle Delete Position buttons
  document.querySelectorAll(".delete-position-btn").forEach((button) => {
    button.addEventListener("click", async function (e) {
      e.preventDefault();
      const positionId = this.dataset.positionId;
      const tokenName = this.dataset.tokenName;

      // Confirm with the user before deleting the position
      if (
        !confirm(
          `Are you sure you want to DELETE your position in ${tokenName}? This will mark the position as closed WITHOUT selling your tokens. Use this only if the position is stuck!`
        )
      ) {
        return;
      }

      // Double confirm for safety
      if (
        !confirm(
          `WARNING: You will keep the tokens in your wallet, but the position will be closed in the database. Proceed?`
        )
      ) {
        return;
      }

      // Disable the button and show loading state
      this.disabled = true;
      this.textContent = "Deleting...";

      try {
        // Make an API call to delete the position
        const response = await fetch(`/api/position/delete/${positionId}`, {
          method: "POST",
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success) {
            alert(
              `Position successfully deleted! P&L value recorded: $${result.profitLoss.toFixed(2)}`
            );
            // Refresh the page to show updated data
            window.location.reload();
          } else {
            alert(`Error deleting position: ${result.error}`);
            // Re-enable the button
            this.disabled = false;
            this.textContent = "Delete Position";
          }
        } else {
          alert("Error communicating with server. Please try again.");
          // Re-enable the button
          this.disabled = false;
          this.textContent = "Delete Position";
        }
      } catch (error) {
        console.error("Error deleting position:", error);
        alert("An unexpected error occurred. Please try again.");
        // Re-enable the button
        this.disabled = false;
        this.textContent = "Delete Position";
      }
    });
  });
}

/**
 * Load and render the balance history chart
 */
async function loadBalanceHistoryChart() {
  try {
    // Fetch balance history data from API
    const response = await fetch("/api/balance-history");

    if (!response.ok) {
      throw new Error("Failed to fetch balance history data");
    }

    const data = await response.json();

    if (!data.dates || !data.totalValues || data.dates.length === 0) {
      console.log("No balance history data available yet");
      return;
    }

    // Create chart
    const ctx = document.getElementById("balanceHistoryChart");

    if (!ctx) {
      console.error("Chart canvas element not found");
      return;
    }

    new Chart(ctx, {
      type: "line",
      data: {
        labels: data.dates,
        datasets: [
          {
            label: "Portfolio Value ($)",
            data: data.totalValues,
            borderColor: "#10b981",
            backgroundColor: "rgba(16, 185, 129, 0.1)",
            borderWidth: 2,
            fill: true,
            tension: 0.4,
          },
          {
            label: "Profit/Loss ($)",
            data: data.profitLossValues,
            borderColor: "#8b5cf6",
            backgroundColor: "rgba(139, 92, 246, 0.1)",
            borderWidth: 2,
            fill: true,
            tension: 0.4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "top",
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                return `${context.dataset.label}: $${context.raw.toFixed(2)}`;
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: false,
            grid: {
              color: "rgba(160, 174, 192, 0.1)",
            },
            ticks: {
              callback: function (value) {
                return "$" + value.toFixed(2);
              },
            },
          },
          x: {
            grid: {
              color: "rgba(160, 174, 192, 0.1)",
            },
          },
        },
      },
    });
  } catch (error) {
    console.error("Error loading balance history chart:", error);
  }
}
