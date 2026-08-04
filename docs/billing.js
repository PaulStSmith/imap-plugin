(function () {
  const checkout = document.getElementById("mail-actions-checkout");
  if (!checkout) {
    return;
  }

  const url = checkout.dataset.checkoutUrl || "";
  const isStripePaymentLink = /^https:\/\/buy\.stripe\.com\//.test(url);
  if (!isStripePaymentLink) {
    checkout.addEventListener("click", function (event) {
      event.preventDefault();
    });
    return;
  }

  checkout.href = url;
  checkout.textContent = "Subscribe to Mail Actions";
  checkout.removeAttribute("aria-disabled");
  checkout.rel = "noopener";
}
)();
