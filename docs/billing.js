(function () {
  document.querySelectorAll("[data-checkout-url]").forEach(function (checkout) {
    const url = checkout.dataset.checkoutUrl || "";
    const isStripePaymentLink = /^https:\/\/buy\.stripe\.com\//.test(url);
    if (!isStripePaymentLink) {
      checkout.addEventListener("click", function (event) {
        event.preventDefault();
      });
      return;
    }

    checkout.href = url;
    checkout.removeAttribute("aria-disabled");
    checkout.rel = "noopener";
  });
}
)();
